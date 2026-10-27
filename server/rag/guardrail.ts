import type { WorkspaceSettings } from '@/lib/contracts'
import { callCore } from '@/server/core'

/**
 * Source guardrail: if even the best retrieved passage is not relevant enough, the model is not
 * called and the user gets INSUFFICIENT_CONTEXT_MESSAGE instead of a plausible-sounding guess.
 *
 * Re-ranker relevance is preferred; cosine similarity is the fallback when re-ranking was off or
 * failed. Fusion (RRF) scores are rank-based and are never used as a relevance signal.
 * Implemented in the Rust core (core/src/guardrail.rs).
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
  return callCore<{ result: GuardrailResult }>('check_guardrail', input).result
}

/** The research step shown under an answer. */
export function describeGuardrail(result: GuardrailResult): string {
  return callCore<string>('describe_guardrail', result)
}
