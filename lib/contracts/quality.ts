/** Answer quality (evaluations, reader feedback) and usage analytics. */
import { z } from 'zod'

import type { ChatMode } from '@/lib/constants'

import type { EvaluationScores } from './chat'

export const analyticsQuerySchema = z.object({ scope: z.enum(['me', 'workspace']).default('me') })

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

/** Calls and tokens of one group of model calls; estimatedCalls were counted from text, not by the vendor. */
export interface TokenCount {
  calls: number
  inputTokens: number
  outputTokens: number
  estimatedCalls: number
}

/** GET /api/usage (workspace admins): the last `days` days, today included (UTC). */
export interface UsageSummary {
  days: number
  totals: TokenCount & { questions: number; failedAnswers: number; activeMembers: number }
  daily: Array<{ date: string; inputTokens: number; outputTokens: number; questions: number }>
  byFeature: Array<TokenCount & { feature: string }>
  byModel: Array<TokenCount & { model: string; kind: 'generate' | 'embed' }>
  byMember: Array<TokenCount & { userId: string | null; email: string | null }>
  storage: { notebooks: number; documents: number; chunks: number; bytes: number }
  studio: { reports: number }
}
