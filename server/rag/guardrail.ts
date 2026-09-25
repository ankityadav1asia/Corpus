import type { WorkspaceSettings } from '@/lib/contracts'

/**
 * Source guardrail: if even the best retrieved passage is not relevant enough, the model is not
 * called and the user gets INSUFFICIENT_CONTEXT_MESSAGE instead of a plausible-sounding guess.
 *
 * Re-ranker relevance is preferred; cosine similarity is the fallback when re-ranking was off or
 * failed. Fusion (RRF) scores are rank-based and are never used as a relevance signal.
 */

export type GuardrailBasis = 'relevance' | 'similarity' | 'no_candidates' | 'unscored' | 'disabled'

export interface GuardrailResult {
  pass: boolean
  basis: GuardrailBasis
  score: number | null
  threshold: number | null
}

export interface GuardrailInput {
  settings: WorkspaceSettings['guardrail']
  candidateCount: number
  /** Best re-ranker score among the kept passages (null when not re-ranked). */
  bestRelevance: number | null
  /** Best cosine similarity among the kept passages (null for keyword-only hits). */
  bestSimilarity: number | null
}

export function checkGuardrail(input: GuardrailInput): GuardrailResult {
  const { settings } = input
  if (!settings.enabled) return { pass: true, basis: 'disabled', score: null, threshold: null }
  if (input.candidateCount === 0) return { pass: false, basis: 'no_candidates', score: null, threshold: null }
  if (input.bestRelevance !== null) {
    return { pass: input.bestRelevance >= settings.minRelevance, basis: 'relevance', score: input.bestRelevance, threshold: settings.minRelevance }
  }
  if (input.bestSimilarity !== null) {
    return { pass: input.bestSimilarity >= settings.minSimilarity, basis: 'similarity', score: input.bestSimilarity, threshold: settings.minSimilarity }
  }
  // Only keyword matches and no re-ranker: there is no calibrated score to judge by.
  return { pass: true, basis: 'unscored', score: null, threshold: null }
}

export function describeGuardrail(result: GuardrailResult): string {
  const format = (value: number | null) => (value === null ? '—' : value.toFixed(2))
  switch (result.basis) {
    case 'disabled':
      return 'Relevance guardrail is turned off for this workspace'
    case 'no_candidates':
      return 'No passages matched the question — answer withheld'
    case 'unscored':
      return 'Only keyword matches were found; no relevance score available'
    case 'relevance':
      return result.pass
        ? `Best re-ranker relevance ${format(result.score)} ≥ threshold ${format(result.threshold)}`
        : `Best re-ranker relevance ${format(result.score)} < threshold ${format(result.threshold)} — answer withheld`
    case 'similarity':
      return result.pass
        ? `Best similarity ${format(result.score)} ≥ threshold ${format(result.threshold)}`
        : `Best similarity ${format(result.score)} < threshold ${format(result.threshold)} — answer withheld`
  }
}
