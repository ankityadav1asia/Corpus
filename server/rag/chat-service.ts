import { INSUFFICIENT_CONTEXT_MESSAGE, type ChatMode } from '@/lib/constants'
import type { Citation, QueryStatus, RetrievalStep, WorkspaceSettings } from '@/lib/contracts'
import type { ChatStreamEvent } from '@/lib/stream-protocol'
import { AiProviderError, DAILY_QUOTA_MESSAGE, type AiProvider, type ChatTurn } from '@/server/ai/provider'
import { AppError, Errors } from '@/server/http/errors'
import { log } from '@/server/logger'
import { buildUserPrompt, deriveTitle, normalizeTurns, systemPrompt } from '@/server/rag/prompt'
import type { Reranker } from '@/server/rag/rerank'
import { describeRetrieval, evaluateRelevance, planRetrieval, rerankCandidates, searchCandidates, toCitations, type RankedHit } from '@/server/rag/retrieval'
import type { Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'

const HISTORY_MESSAGES = 8

export interface ChatDeps {
  repos: Pick<Repositories, 'collections' | 'conversations' | 'documents' | 'analytics' | 'workspaces' | 'jobs'>
  ai: AiProvider
  reranker: Reranker | null
  /** Sampling source for background evaluation (injectable for tests). */
  random?: () => number
}

export interface PreparedChat {
  workspaceId: string
  userId: string
  conversationId: string
  conversationTitle: string
  createdConversation: boolean
  collectionId: string | null
  mode: ChatMode
  question: string
  history: ChatTurn[]
  userMessageId: string
  settings: WorkspaceSettings
  startedAt: number
}

/**
 * Validates access, creates the conversation on first message and stores the user turn.
 * Runs before streaming starts so failures become normal HTTP errors (404, 429, …).
 * History comes from the database — the client can never inject fake assistant turns.
 */
export async function prepareChat(
  deps: ChatDeps,
  input: { workspaceId: string; userId: string; message: string; conversationId?: string | null; collectionId?: string | null; mode: ChatMode },
): Promise<PreparedChat> {
  const startedAt = Date.now()
  const collectionId = input.collectionId ?? null
  const [settings, collection] = await Promise.all([
    deps.repos.workspaces.settings(input.workspaceId),
    collectionId ? deps.repos.collections.get(input.workspaceId, collectionId, input.userId) : Promise.resolve(null),
  ])
  if (collectionId && !collection) throw Errors.notFound('Notebook')

  let conversation
  let createdConversation = false
  if (input.conversationId) {
    conversation = await deps.repos.conversations.get(input.workspaceId, input.userId, input.conversationId)
    if (!conversation) throw Errors.notFound('Conversation')
  } else {
    conversation = await deps.repos.conversations.create({
      workspaceId: input.workspaceId,
      ownerId: input.userId,
      collectionId,
      title: deriveTitle(input.message),
    })
    createdConversation = true
  }

  const history = createdConversation ? [] : normalizeTurns(await deps.repos.conversations.recentTurns(conversation.id, HISTORY_MESSAGES))
  const userMessage = await deps.repos.conversations.addMessage({ conversationId: conversation.id, role: 'user', content: input.message })

  return {
    workspaceId: input.workspaceId,
    userId: input.userId,
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    createdConversation,
    collectionId,
    mode: input.mode,
    question: input.message,
    history,
    userMessageId: userMessage.id,
    settings,
    startedAt,
  }
}

function userFacingMessage(error: unknown): string {
  if (error instanceof AppError) return error.message
  if (error instanceof AiProviderError) {
    if (error.dailyQuota) return DAILY_QUOTA_MESSAGE
    return error.status === 429 ? 'The AI service is rate-limiting requests. Please try again in a minute.' : 'The AI service could not answer right now. Please try again.'
  }
  return 'Something went wrong while answering. Please try again.'
}

/** Queues quality scoring for a sample of answers; never fails the chat. */
async function scheduleEvaluation(deps: ChatDeps, chat: PreparedChat, messageId: string, hits: readonly RankedHit[]) {
  const { enabled, sampleRate } = chat.settings.evaluation
  if (!enabled || hits.length === 0 || (deps.random ?? Math.random)() >= sampleRate) return
  try {
    await deps.repos.jobs.enqueue('evaluate_answer', { messageId, chunkIds: hits.map((hit) => hit.chunkId) }, { maxAttempts: JOB_ATTEMPTS.evaluate_answer })
  } catch (error) {
    log.warn('Could not queue answer evaluation', { error: String(error) })
  }
}

export async function* runChat(deps: ChatDeps, chat: PreparedChat, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
  let answer = ''
  let citations: Citation[] = []
  let steps: RetrievalStep[] = []
  let chunksRetrieved = 0
  let finished = false
  let outcome: QueryStatus = 'error'
  const scope = { workspaceId: chat.workspaceId, collectionId: chat.collectionId }
  const { retrieval, guardrail: guardrailSettings } = chat.settings

  yield {
    type: 'start',
    conversationId: chat.conversationId,
    conversationTitle: chat.conversationTitle,
    createdConversation: chat.createdConversation,
    userMessageId: chat.userMessageId,
  }

  try {
    if (chat.mode === 'deep') yield { type: 'status', stage: 'planning', message: 'Expanding the question (multi-query, step-back, HyDE)…' }
    const plan = await planRetrieval(deps.ai, { question: chat.question, history: chat.history, mode: chat.mode, signal }, retrieval)

    yield { type: 'status', stage: 'searching', message: 'Searching your notebooks…' }
    const { candidates, searches } = await searchCandidates(deps, scope, plan, retrieval.candidatePool, signal)

    if (retrieval.rerank && deps.reranker && candidates.length > 0) {
      yield { type: 'status', stage: 'reranking', message: `Re-ranking ${candidates.length} passage${candidates.length === 1 ? '' : 's'}…` }
    }
    const rerank = await rerankCandidates(deps, chat.question, candidates, { topK: retrieval.topK, enabled: retrieval.rerank }, signal)
    const guardrail = evaluateRelevance(guardrailSettings, candidates.length, rerank.hits)
    const hits = guardrail.pass ? rerank.hits : []
    chunksRetrieved = hits.length
    citations = toCitations(hits)
    steps = describeRetrieval({ mode: chat.mode, plan, candidateCount: candidates.length, searches, rerank, guardrail })
    yield { type: 'sources', citations, steps }

    if (!guardrail.pass) {
      // Short-circuit: nothing relevant enough, so the model is never asked to improvise.
      answer = INSUFFICIENT_CONTEXT_MESSAGE
      yield { type: 'delta', text: answer }
      const saved = await deps.repos.conversations.addMessage({ conversationId: chat.conversationId, role: 'assistant', content: answer, citations, steps })
      finished = true
      outcome = 'insufficient_context'
      yield { type: 'done', assistantMessageId: saved.id }
      return
    }

    yield { type: 'status', stage: 'generating', message: 'Writing the answer…' }
    const turns = normalizeTurns([...chat.history, { role: 'user', content: buildUserPrompt(chat.question, hits) }])
    // Standard mode skips the model's thinking phase so the first words arrive sooner.
    for await (const text of deps.ai.streamChat({ system: systemPrompt(chat.mode), turns, fast: chat.mode === 'standard', signal })) {
      answer += text
      yield { type: 'delta', text }
    }
    if (!answer.trim()) {
      throw new AppError(502, 'EMPTY_ANSWER', 'The model returned no answer (it may have been blocked by a safety filter). Try rephrasing.')
    }

    const saved = await deps.repos.conversations.addMessage({ conversationId: chat.conversationId, role: 'assistant', content: answer, citations, steps })
    finished = true
    outcome = 'ok'
    await scheduleEvaluation(deps, chat, saved.id, hits)
    yield { type: 'done', assistantMessageId: saved.id }
  } catch (error) {
    if (!signal?.aborted) {
      log.error('Chat generation failed', error, { conversationId: chat.conversationId })
      yield { type: 'error', message: userFacingMessage(error) }
    }
  } finally {
    // Reached on success, on error, and when the client disconnects mid-stream.
    if (!finished && answer.trim()) {
      await deps.repos.conversations
        .addMessage({ conversationId: chat.conversationId, role: 'assistant', content: answer, citations, steps })
        .catch((error) => log.error('Could not save partial answer', error, { conversationId: chat.conversationId }))
    }
    await deps.repos.conversations.touch(chat.conversationId, chat.collectionId).catch((error) => log.warn('Could not update conversation timestamp', { error: String(error) }))
    await deps.repos.analytics
      .log({
        workspaceId: chat.workspaceId,
        ownerId: chat.userId,
        collectionId: chat.collectionId,
        mode: chat.mode,
        query: chat.question,
        latencyMs: Date.now() - chat.startedAt,
        chunksRetrieved,
        // A disconnect before completion is recorded as an error (the answer was not delivered).
        status: finished ? outcome : 'error',
      })
      .catch((error) => log.warn('Could not write query log', { error: String(error) }))
  }
}
