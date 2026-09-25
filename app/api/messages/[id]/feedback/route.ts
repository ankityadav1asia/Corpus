import { feedbackSchema, idSchema } from '@/lib/contracts'
import { parseWith, readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

/**
 * Rates an answer (1 helpful, -1 not helpful, 0 clears the rating). Only the author of the
 * conversation can rate its answers — conversations are private.
 */
export const PUT = workspaceRoute<{ id: string }>(async ({ req, params, access }) => {
  const id = parseWith(idSchema, params.id)
  const input = await readJson(req, feedbackSchema, 8 * 1024)
  const { repos } = getServices()
  await enforceRateLimit(repos, `feedback:user:${access.userId}`, RATE_LIMITS.feedback)
  const context = await repos.conversations.messageContext(id)
  if (!context || context.workspaceId !== access.workspaceId || context.ownerId !== access.userId || context.role !== 'assistant') {
    throw Errors.notFound('Answer')
  }
  if (input.rating === 0) {
    await repos.feedback.remove(id, access.userId)
    return json({ feedback: null })
  }
  const comment = input.comment ? input.comment : null
  await repos.feedback.set({ messageId: id, userId: access.userId, workspaceId: access.workspaceId, rating: input.rating, comment })
  return json({ feedback: { rating: input.rating, comment } })
})
