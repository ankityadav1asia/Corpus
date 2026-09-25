import type { BotMessagePayload } from '@/server/integrations/service'
import { createBotFrameworkVerifier } from '@/server/integrations/teams'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { log } from '@/server/logger'
import type { Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'

let verifier: { fetch: typeof fetch; verify: ReturnType<typeof createBotFrameworkVerifier> } | null = null

/** One Bot Framework verifier (with its cached Microsoft keys) per fetch implementation. */
export function teamsVerifier(fetcher: typeof fetch) {
  if (!verifier || verifier.fetch !== fetcher) verifier = { fetch: fetcher, verify: createBotFrameworkVerifier(fetcher) }
  return verifier.verify
}

/**
 * Queues a chat-app question for the background answerer. Over the per-integration limit the
 * question is dropped (the platform still gets its quick 200, so it does not retry).
 */
export async function queueBotQuestion(repos: Pick<Repositories, 'jobs' | 'rateLimits'>, payload: BotMessagePayload): Promise<boolean> {
  try {
    await enforceRateLimit(repos, `bot:${payload.integrationId}`, RATE_LIMITS.botMessages)
  } catch {
    log.warn('Chat-app bot rate limit reached', { integrationId: payload.integrationId })
    return false
  }
  await repos.jobs.enqueue('answer_bot_message', payload, { maxAttempts: JOB_ATTEMPTS.answer_bot_message })
  processJobsAfterResponse()
  return true
}
