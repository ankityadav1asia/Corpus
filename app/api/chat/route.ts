import { chatRequestSchema } from '@/lib/contracts'
import { readJson } from '@/server/http/body'
import { workspaceRoute } from '@/server/http/route'
import { ndjsonResponse } from '@/server/http/stream'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { prepareChat, runChat } from '@/server/rag/chat-service'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

// The answer streams first, then queued work runs after the response (Next.js after). 300 s is the
// most Vercel allows on the Hobby plan.
export const maxDuration = 300

/**
 * The client sends only the new question. History, access and conversation ids are resolved on
 * the server, and progress + the answer stream back as NDJSON events. Every workspace member
 * (Viewer and up) may search every notebook of the workspace.
 */
export const POST = workspaceRoute(async ({ req, access }) => {
  const input = await readJson(req, chatRequestSchema, 16 * 1024)
  const services = getServices()
  await enforceRateLimit(services.repos, `chat:user:${access.userId}`, RATE_LIMITS.chat)

  const deps = { repos: services.repos, ai: services.ai(), reranker: services.reranker() }
  const prepared = await prepareChat(deps, {
    workspaceId: access.workspaceId,
    userId: access.userId,
    message: input.message,
    conversationId: input.conversationId,
    collectionId: input.collectionId,
    mode: input.mode,
  })

  const abort = new AbortController()
  req.signal.addEventListener('abort', () => abort.abort(), { once: true })
  // Evaluation jobs queued by this answer are processed once the stream has finished.
  processJobsAfterResponse()
  return ndjsonResponse(runChat(deps, prepared, abort.signal), abort)
})
