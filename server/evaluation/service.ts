import { z } from 'zod'

import type { AiProvider } from '@/server/ai/provider'
import { judgeAnswer } from '@/server/evaluation/judge'
import type { Reranker } from '@/server/rag/rerank'
import type { Repositories } from '@/server/repositories'

export interface EvaluationDeps {
  repos: Pick<Repositories, 'conversations' | 'documents' | 'chunks' | 'evaluations' | 'workspaces' | 'notifications'>
  ai: AiProvider
  reranker: Reranker | null
}

export const evaluateAnswerPayload = z.object({ messageId: z.guid(), chunkIds: z.array(z.guid()).max(50) })

/** Scores one live answer against the passages it was generated from. */
export async function evaluateMessage(deps: EvaluationDeps, payload: z.infer<typeof evaluateAnswerPayload>): Promise<'scored' | 'skipped'> {
  const target = await deps.repos.conversations.questionFor(payload.messageId)
  if (!target) return 'skipped' // message or conversation deleted meanwhile
  const passages = await deps.repos.chunks.texts(target.workspaceId, payload.chunkIds)
  const { scores, details } = await judgeAnswer(deps.ai, {
    question: target.question,
    answer: target.answer,
    passages: passages.map((passage) => passage.content),
    reference: null,
  })
  await deps.repos.evaluations.save({
    workspaceId: target.workspaceId,
    messageId: payload.messageId,
    question: target.question,
    answer: target.answer,
    scores,
    details: { ...details, chunkIds: passages.map((passage) => passage.id) },
    model: deps.ai.chatModel,
  })
  return 'scored'
}
