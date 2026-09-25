/** Chat requests, conversations, answers with citations, and feedback. */
import { z } from 'zod'

import { CHAT_MODES, LIMITS } from '@/lib/constants'

import type { SourceType } from './documents'
import { id, requiredText } from './fields'

export const chatRequestSchema = z.object({
  message: requiredText(LIMITS.chatMessageChars),
  conversationId: id.nullish(),
  /** null / omitted = search every notebook in the workspace. */
  collectionId: id.nullish(),
  mode: z.enum(CHAT_MODES).default('standard'),
})

export const conversationUpdateSchema = z
  .object({ title: requiredText(LIMITS.conversationTitleChars).optional(), pinned: z.boolean().optional() })
  .refine((value) => value.title !== undefined || value.pinned !== undefined, 'Nothing to update')

export const branchConversationSchema = z.object({ messageId: id })

/** History search: matches conversation titles and message text (literal, case-insensitive). */
export const conversationsQuerySchema = z.object({
  q: z.string().trim().max(LIMITS.explorerSearchChars).optional(),
})

/** 1 = helpful, -1 = not helpful, 0 = remove my rating. */
export const feedbackSchema = z.object({
  rating: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  comment: z.string().trim().max(LIMITS.feedbackCommentChars).optional(),
})

export interface Citation {
  /** 1-based number the model uses for inline references like [1]. */
  index: number
  chunkId: string | null
  documentId: string | null
  title: string
  source: string
  sourceType: SourceType | null
  excerpt: string
  /** Cosine similarity when the passage came from vector search; null for keyword-only hits. */
  similarity: number | null
  /** Re-ranker relevance (0–1); null when re-ranking was off or failed. */
  relevance?: number | null
}

export interface RetrievalStep {
  label: string
  detail: string
}

export interface EvaluationScores {
  faithfulness: number | null
  answerRelevance: number | null
  contextPrecision: number | null
  contextRecall: number | null
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations: Citation[]
  steps: RetrievalStep[]
  createdAt: string
  /** Background quality scores, once available. */
  evaluation?: EvaluationScores | null
  /** The caller's own rating of this answer. */
  feedback?: { rating: 1 | -1; comment: string | null } | null
  /** Suggested next questions (answers only), once generated. */
  followups?: string[] | null
}

export interface ConversationSummary {
  id: string
  title: string
  collectionId: string | null
  parentId: string | null
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface ConversationDetail {
  conversation: ConversationSummary
  messages: ChatMessage[]
}
