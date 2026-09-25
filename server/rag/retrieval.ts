import type { ChatMode } from '@/lib/constants'
import type { Citation, RetrievalStep, WorkspaceSettings } from '@/lib/contracts'
import type { AiProvider, ChatTurn } from '@/server/ai/provider'
import { log } from '@/server/logger'
import { checkGuardrail, describeGuardrail, type GuardrailResult } from '@/server/rag/guardrail'
import { embedQueriesCached, withDeadline } from '@/server/rag/query-cache'
import { planQueries, type QueryPlan } from '@/server/rag/query-transform'
import type { Reranker } from '@/server/rag/rerank'
import type { Repositories } from '@/server/repositories'
import type { SearchHit } from '@/server/repositories/documents'

/**
 * Retrieval pipeline, as separate stages so the chat service can stream progress between them:
 *
 *   plan (deep mode: multi-query + step-back + HyDE, concurrently)
 *   → search (vector + full-text for every query, HyDE vector search, all in parallel)
 *   → fuse (Reciprocal Rank Fusion, top N candidates)
 *   → re-rank (top K)
 *   → guardrail (withhold the answer when nothing is relevant enough)
 */

const RRF_K = 60

/**
 * Longest a helper stage may hold up an answer. When one runs over, the pipeline carries on without
 * it (the question as asked, or fusion order instead of re-ranking) and says so in the steps.
 */
export const STAGE_TIMEOUTS_MS = { planning: 8_000, rerank: 8_000 }

export interface RetrievalDeps {
  repos: Pick<Repositories, 'documents'>
  ai: AiProvider
  reranker: Reranker | null
}

export interface RetrievalScope {
  workspaceId: string
  collectionId: string | null
}

export interface RankedHit extends SearchHit {
  /** Re-ranker relevance 0–1 (null when not re-ranked). */
  relevance: number | null
}

export interface RerankOutcome {
  hits: RankedHit[]
  method: 'cohere' | 'llm' | 'none'
  failed: boolean
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ 1 / (k + rank). Rank-based, so it needs no score
 * normalisation between cosine similarity and ts_rank. Keeps the best similarity seen per chunk.
 */
export function fuseRankedLists(lists: ReadonlyArray<readonly SearchHit[]>, limit: number, k = RRF_K): SearchHit[] {
  const fused = new Map<string, { hit: SearchHit; score: number }>()
  for (const list of lists) {
    list.forEach((hit, index) => {
      const entry = fused.get(hit.chunkId)
      const increment = 1 / (k + index + 1)
      if (!entry) {
        fused.set(hit.chunkId, { hit: { ...hit }, score: increment })
        return
      }
      entry.score += increment
      if (hit.similarity !== null && (entry.hit.similarity === null || hit.similarity > entry.hit.similarity)) {
        entry.hit.similarity = hit.similarity
      }
    })
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.hit.chunkId.localeCompare(b.hit.chunkId))
    .slice(0, limit)
    .map((entry) => entry.hit)
}

export function plainPlan(question: string): QueryPlan {
  return { question, variants: [], stepBack: null, hypothetical: null, failures: [] }
}

/** A question to answer, with the conversation so far. */
export interface RetrievalRequest {
  question: string
  history: readonly ChatTurn[]
  mode: ChatMode
  signal?: AbortSignal
}

/** Deep mode expands the question (multi-query, step-back, HyDE); standard mode searches it as asked. */
export function planRetrieval(ai: AiProvider, request: RetrievalRequest, settings: WorkspaceSettings['retrieval']): Promise<QueryPlan> {
  if (request.mode === 'standard') return Promise.resolve(plainPlan(request.question))
  return planQueries(
    ai,
    request.question,
    request.history,
    { multiQueryCount: settings.multiQueryCount, stepBack: settings.stepBack, hyde: settings.hyde },
    withDeadline(request.signal, STAGE_TIMEOUTS_MS.planning),
  )
}

/** Every text query searched: the question, its variations and the step-back question. */
export function searchQueries(plan: QueryPlan): string[] {
  return [plan.question, ...plan.variants, ...(plan.stepBack ? [plan.stepBack] : [])]
}

export async function searchCandidates(
  deps: RetrievalDeps,
  scope: RetrievalScope,
  plan: QueryPlan,
  pool: number,
  signal?: AbortSignal,
): Promise<{ candidates: SearchHit[]; searches: number }> {
  const queries = searchQueries(plan)
  const [queryEmbeddings, hydeEmbedding] = await Promise.all([
    embedQueriesCached(deps.ai, queries, signal),
    plan.hypothetical
      ? deps.ai
          .embedDocuments([plan.hypothetical], signal)
          .then((vectors) => vectors[0] ?? null)
          .catch((error: unknown) => {
            log.warn('HyDE embedding failed; continuing without it', { error: String(error) })
            return null
          })
      : Promise.resolve(null),
  ])
  const perSearch = Math.max(pool, 10)
  const searches = queries.flatMap((query, index) => [
    deps.repos.documents.vectorSearch({ ...scope, embedding: queryEmbeddings[index]!, embeddingModel: deps.ai.embeddingModel, limit: perSearch }),
    deps.repos.documents.keywordSearch({ ...scope, query, limit: perSearch }),
  ])
  if (hydeEmbedding) searches.push(deps.repos.documents.vectorSearch({ ...scope, embedding: hydeEmbedding, embeddingModel: deps.ai.embeddingModel, limit: perSearch }))
  const lists = await Promise.all(searches)
  return { candidates: fuseRankedLists(lists, pool), searches: lists.length }
}

export async function rerankCandidates(
  deps: RetrievalDeps,
  question: string,
  candidates: readonly SearchHit[],
  options: { topK: number; enabled: boolean },
  signal?: AbortSignal,
): Promise<RerankOutcome> {
  const fallback = (method: RerankOutcome['method'], failed: boolean): RerankOutcome => ({
    hits: candidates.slice(0, options.topK).map((hit) => ({ ...hit, relevance: null })),
    method,
    failed,
  })
  if (!options.enabled || !deps.reranker || candidates.length === 0) return fallback('none', false)
  try {
    const results = await deps.reranker.rerank(
      question,
      candidates.map((hit) => ({ id: hit.chunkId, text: hit.content })),
      options.topK,
      withDeadline(signal, STAGE_TIMEOUTS_MS.rerank),
    )
    const byId = new Map(candidates.map((hit) => [hit.chunkId, hit]))
    const hits = results.flatMap((result) => {
      const hit = byId.get(result.id)
      return hit ? [{ ...hit, relevance: result.score }] : []
    })
    return hits.length ? { hits, method: deps.reranker.name, failed: false } : fallback(deps.reranker.name, true)
  } catch (error) {
    if (signal?.aborted) throw error
    log.warn('Re-ranking failed; using fusion order', { reranker: deps.reranker.name, error: String(error) })
    return fallback(deps.reranker.name, true)
  }
}

export function evaluateRelevance(settings: WorkspaceSettings['guardrail'], candidateCount: number, hits: readonly RankedHit[]): GuardrailResult {
  const best = (values: Array<number | null>) => values.reduce<number | null>((max, value) => (value !== null && (max === null || value > max) ? value : max), null)
  return checkGuardrail({
    settings,
    candidateCount,
    bestRelevance: best(hits.map((hit) => hit.relevance)),
    bestSimilarity: best(hits.map((hit) => hit.similarity)),
  })
}

const quote = (value: string) => `“${value}”`
const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max).trimEnd()}…` : value)

/** Human-readable account of what the pipeline actually did (shown under each answer). */
export function describeRetrieval(input: {
  mode: ChatMode
  plan: QueryPlan
  candidateCount: number
  searches: number
  rerank: RerankOutcome
  guardrail: GuardrailResult
}): RetrievalStep[] {
  const steps: RetrievalStep[] = []
  if (input.mode === 'deep') {
    steps.push({
      label: 'Query expansion',
      detail: input.plan.variants.length ? input.plan.variants.map(quote).join(' · ') : 'Unavailable — searched the question as asked',
    })
    if (input.plan.stepBack) steps.push({ label: 'Step-back question', detail: quote(input.plan.stepBack) })
    if (input.plan.hypothetical) steps.push({ label: 'Hypothetical answer (HyDE)', detail: truncate(input.plan.hypothetical, 220) })
  }
  steps.push({
    label: 'Retrieved',
    detail: `${input.candidateCount} candidate passage${input.candidateCount === 1 ? '' : 's'} from ${input.searches} searches (vector + full-text, fused with RRF)`,
  })
  if (input.rerank.method !== 'none') {
    const name = input.rerank.method === 'llm' ? 'Gemini' : 'Cohere'
    steps.push({
      label: 'Re-ranked',
      detail: input.rerank.failed
        ? `${name} re-ranker unavailable — kept the top ${input.rerank.hits.length} by fusion order`
        : `Kept the top ${input.rerank.hits.length} of ${input.candidateCount} with the ${name} re-ranker`,
    })
  }
  steps.push({ label: 'Relevance check', detail: describeGuardrail(input.guardrail) })
  return steps
}

export interface RetrievalResult {
  plan: QueryPlan
  candidateCount: number
  hits: RankedHit[]
  guardrail: GuardrailResult
  steps: RetrievalStep[]
}

/** The whole pipeline in one call (benchmarks); the chat service runs the stages itself to stream progress. */
export async function retrieve(deps: RetrievalDeps, scope: RetrievalScope, input: RetrievalRequest & { settings: WorkspaceSettings }): Promise<RetrievalResult> {
  const { retrieval } = input.settings
  const plan = await planRetrieval(deps.ai, input, retrieval)
  const { candidates, searches } = await searchCandidates(deps, scope, plan, retrieval.candidatePool, input.signal)
  const rerank = await rerankCandidates(deps, input.question, candidates, { topK: retrieval.topK, enabled: retrieval.rerank }, input.signal)
  const guardrail = evaluateRelevance(input.settings.guardrail, candidates.length, rerank.hits)
  return {
    plan,
    candidateCount: candidates.length,
    hits: rerank.hits,
    guardrail,
    steps: describeRetrieval({ mode: input.mode, plan, candidateCount: candidates.length, searches, rerank, guardrail }),
  }
}

export function toCitations(hits: readonly RankedHit[]): Citation[] {
  return hits.map((hit, index) => ({
    index: index + 1,
    chunkId: hit.chunkId,
    documentId: hit.documentId,
    title: hit.title,
    source: hit.source,
    sourceType: hit.sourceType,
    excerpt: truncate(hit.content, 280),
    similarity: hit.similarity === null ? null : Math.round(hit.similarity * 1000) / 1000,
    relevance: hit.relevance,
  }))
}
