/** Answer quality (evaluations, benchmarks, reader feedback) and usage analytics. */
import { z } from 'zod'

import { LIMITS, type ChatMode } from '@/lib/constants'

import type { EvaluationScores } from './chat'
import type { JobStatus } from './common'
import { id, requiredText } from './fields'

export const evalCaseSchema = z.object({
  question: requiredText(LIMITS.evalQuestionChars),
  referenceAnswer: requiredText(LIMITS.evalReferenceChars),
  collectionId: id.nullish(),
})

export const analyticsQuerySchema = z.object({ scope: z.enum(['me', 'workspace']).default('me') })

export interface EvalCase {
  id: string
  question: string
  referenceAnswer: string
  collectionId: string | null
  createdAt: string
}

export interface EvalRunSummary {
  id: string
  status: JobStatus
  caseCount: number
  completedCount: number
  averages: EvaluationScores
  createdAt: string
  finishedAt: string | null
  error: string | null
}

export interface QualitySummary {
  days: number
  evaluated: number
  averages: EvaluationScores
  trend: Array<{ day: string; count: number; faithfulness: number | null; answerRelevance: number | null; contextPrecision: number | null }>
  flagged: Array<{
    id: string
    question: string
    conversationId: string | null
    scores: EvaluationScores
    createdAt: string
  }>
  lastBenchmark: EvalRunSummary | null
  /** Thumbs up / down from readers (admins: everyone's; others: their own). */
  feedback: {
    positive: number
    negative: number
    recent: Array<{ messageId: string; question: string | null; rating: 1 | -1; comment: string | null; userEmail: string | null; createdAt: string }>
  }
}

export type QueryStatus = 'ok' | 'error' | 'insufficient_context'

export interface AnalyticsResponse {
  scope: 'me' | 'workspace'
  totals: { queries: number; errors: number; insufficient: number; avgLatencyMs: number | null; p95LatencyMs: number | null }
  byMode: Record<ChatMode, number>
  recent: Array<{
    id: string
    query: string
    mode: ChatMode
    collectionId: string | null
    latencyMs: number
    chunksRetrieved: number
    status: QueryStatus
    createdAt: string
  }>
}
