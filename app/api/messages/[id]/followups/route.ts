import { INSUFFICIENT_CONTEXT_MESSAGE } from '@/lib/constants'
import { idSchema } from '@/lib/contracts'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { log } from '@/server/logger'
import { suggestFollowups } from '@/server/rag/followups'
import { withDeadline } from '@/server/rag/query-cache'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

const FOLLOWUP_TIMEOUT_MS = 10_000

/**
 * Suggested follow-up questions for one of the caller's answers. Generated on first request (after
 * the answer has streamed) and stored, so reopening the chat shows them without another model call.
 * Suggestions are optional: any failure returns an empty list rather than an error.
 */
export const POST = workspaceRoute<{ id: string }>(async ({ req, params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos, ai } = getServices()
  const source = await repos.conversations.followupSource(id)
  if (!source || source.workspaceId !== access.workspaceId || source.ownerId !== access.userId || source.role !== 'assistant') {
    throw Errors.notFound('Answer')
  }
  if (source.followups) return json({ followups: source.followups })
  // Demo visitors spend the model quota on answers only.
  if (access.isGuest) return json({ followups: [] })
  if (!source.question || source.citations.length === 0 || source.answer.trim() === INSUFFICIENT_CONTEXT_MESSAGE) return json({ followups: [] })

  await enforceRateLimit(repos, `followups:user:${access.userId}`, RATE_LIMITS.followups)
  try {
    const followups = await suggestFollowups(
      ai(),
      { question: source.question, answer: source.answer, sources: [...new Set(source.citations.map((citation) => citation.title))] },
      withDeadline(req.signal, FOLLOWUP_TIMEOUT_MS),
    )
    if (followups.length > 0) await repos.conversations.setFollowups(id, followups)
    return json({ followups })
  } catch (error) {
    log.warn('Could not suggest follow-up questions', { error: String(error) })
    return json({ followups: [] })
  }
})
