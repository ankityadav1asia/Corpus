import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { workspaceSettingsSchema } from '@/lib/contracts'
import { checkGuardrail, describeGuardrail } from '@/server/rag/guardrail'
import type { Reranker } from '@/server/rag/rerank'
import { describeRetrieval, evaluateRelevance, plainPlan, rerankCandidates, type RankedHit } from '@/server/rag/retrieval'
import type { SearchHit } from '@/server/repositories/documents'

import { createFakeAi } from './helpers/fake-ai'

const settings = workspaceSettingsSchema.parse({}).guardrail // minRelevance 0.35, minSimilarity 0.45

const hit = (id: string, similarity: number | null = null): SearchHit => ({
  chunkId: id,
  documentId: 'd',
  collectionId: 'c',
  content: `content ${id}`,
  title: id,
  source: id,
  sourceType: 'text',
  similarity,
})
const ranked = (id: string, relevance: number | null, similarity: number | null = null): RankedHit => ({ ...hit(id, similarity), relevance })

// Unused members of the dependency bag for rerankCandidates.
const noRepos = { documents: {} } as never

describe('guardrail decision', () => {
  it('withholds the answer when nothing was found', () => {
    assert.deepEqual(checkGuardrail({ settings, candidateCount: 0, bestRelevance: null, bestSimilarity: null }), {
      pass: false,
      basis: 'no_candidates',
      score: null,
      threshold: null,
    })
  })

  it('prefers the re-ranker score and treats the threshold as inclusive', () => {
    assert.equal(checkGuardrail({ settings, candidateCount: 5, bestRelevance: 0.35, bestSimilarity: 0.1 }).pass, true)
    const low = checkGuardrail({ settings, candidateCount: 5, bestRelevance: 0.34, bestSimilarity: 0.99 })
    assert.deepEqual(low, { pass: false, basis: 'relevance', score: 0.34, threshold: 0.35 }, 'high cosine similarity does not overrule a low re-ranker score')
  })

  it('falls back to cosine similarity when there is no re-ranker score', () => {
    assert.deepEqual(checkGuardrail({ settings, candidateCount: 5, bestRelevance: null, bestSimilarity: 0.44 }), {
      pass: false,
      basis: 'similarity',
      score: 0.44,
      threshold: 0.45,
    })
    assert.equal(checkGuardrail({ settings, candidateCount: 5, bestRelevance: null, bestSimilarity: 0.6 }).pass, true)
  })

  it('lets keyword-only matches through (no calibrated score) and can be disabled', () => {
    assert.equal(checkGuardrail({ settings, candidateCount: 3, bestRelevance: null, bestSimilarity: null }).basis, 'unscored')
    assert.equal(checkGuardrail({ settings, candidateCount: 3, bestRelevance: null, bestSimilarity: null }).pass, true)
    const off = checkGuardrail({ settings: { ...settings, enabled: false }, candidateCount: 0, bestRelevance: null, bestSimilarity: null })
    assert.deepEqual(off, { pass: true, basis: 'disabled', score: null, threshold: null })
  })

  it('uses the best score across the kept passages, ignoring missing ones', () => {
    const result = evaluateRelevance(settings, 3, [ranked('a', null, 0.2), ranked('b', 0.1), ranked('c', 0.8, null)])
    assert.deepEqual(result, { pass: true, basis: 'relevance', score: 0.8, threshold: 0.35 })
    const bySimilarity = evaluateRelevance(settings, 2, [ranked('a', null, 0.3), ranked('b', null, 0.5)])
    assert.equal(bySimilarity.score, 0.5)
  })

  it('explains every decision in words shown under the answer', () => {
    assert.match(describeGuardrail({ pass: false, basis: 'relevance', score: 0.2, threshold: 0.35 }), /0\.20 < threshold 0\.35 — answer withheld/)
    assert.match(describeGuardrail({ pass: true, basis: 'similarity', score: 0.5, threshold: 0.45 }), /0\.50 ≥ threshold 0\.45/)
    assert.match(describeGuardrail({ pass: false, basis: 'no_candidates', score: null, threshold: null }), /No passages/)
    const steps = describeRetrieval({
      mode: 'standard',
      plan: plainPlan('q'),
      candidateCount: 1,
      searches: 2,
      rerank: { hits: [], method: 'none', failed: false },
      guardrail: { pass: true, basis: 'unscored', score: null, threshold: null },
    })
    assert.deepEqual(
      steps.map((s) => s.label),
      ['Retrieved', 'Relevance check'],
    )
    assert.match(steps[0]!.detail, /1 candidate passage from 2 searches/)
  })
})

describe('re-ranking stage', () => {
  const candidates = [hit('a', 0.9), hit('b', 0.8), hit('c', 0.7), hit('d', 0.6)]

  it('keeps fusion order (top K) when re-ranking is off or unavailable', async () => {
    const off = await rerankCandidates({ repos: noRepos, ai: createFakeAi(), reranker: null }, 'q', candidates, { topK: 2, enabled: true })
    assert.deepEqual(
      off.hits.map((h) => [h.chunkId, h.relevance]),
      [
        ['a', null],
        ['b', null],
      ],
    )
    assert.equal(off.method, 'none')
  })

  it('reorders by re-ranker score, attaches relevance and drops unknown ids', async () => {
    const reranker: Reranker = {
      name: 'cohere',
      async rerank(_query, items, topK) {
        assert.equal(items.length, 4)
        return [
          { id: 'c', score: 0.9 },
          { id: 'ghost', score: 0.8 },
          { id: 'a', score: 0.4 },
        ].slice(0, topK + 1)
      },
    }
    const outcome = await rerankCandidates({ repos: noRepos, ai: createFakeAi(), reranker }, 'q', candidates, { topK: 2, enabled: true })
    assert.deepEqual(
      outcome.hits.map((h) => [h.chunkId, h.relevance, h.similarity]),
      [
        ['c', 0.9, 0.7],
        ['a', 0.4, 0.9],
      ],
    )
    assert.deepEqual([outcome.method, outcome.failed], ['cohere', false])
  })

  it('falls back to fusion order when the re-ranker throws or returns nothing usable', async () => {
    const throwing: Reranker = {
      name: 'llm',
      rerank: async () => {
        throw new Error('quota exceeded')
      },
    }
    const failed = await rerankCandidates({ repos: noRepos, ai: createFakeAi(), reranker: throwing }, 'q', candidates, { topK: 3, enabled: true })
    assert.deepEqual([failed.method, failed.failed, failed.hits.length], ['llm', true, 3])
    const empty: Reranker = { name: 'llm', rerank: async () => [{ id: 'ghost', score: 1 }] }
    const none = await rerankCandidates({ repos: noRepos, ai: createFakeAi(), reranker: empty }, 'q', candidates, { topK: 3, enabled: true })
    assert.deepEqual([none.failed, none.hits[0]?.chunkId], [true, 'a'])
    const disabled = await rerankCandidates({ repos: noRepos, ai: createFakeAi(), reranker: throwing }, 'q', candidates, { topK: 3, enabled: false })
    assert.deepEqual([disabled.method, disabled.failed], ['none', false])
  })
})
