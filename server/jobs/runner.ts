import { queueDueSyncs } from '@/server/connectors/sync'
import { AiProviderError, DAILY_QUOTA_MESSAGE } from '@/server/ai/provider'
import type { JobContext } from '@/server/jobs/context'
import { JOBS } from '@/server/jobs/definitions'
import { PermanentJobError } from '@/server/jobs/errors'
import { log } from '@/server/logger'
import { JOB_ATTEMPTS, type JobRecord, type JobType } from '@/server/repositories/jobs'

export type { JobContext }

/**
 * Executes queued background work (reading media, indexing, re-embedding, answer evaluation,
 * benchmark runs, reports, images, audio overviews, mind maps, connector syncs, chat-app answers;
 * see server/jobs/definitions.ts). Called after responses (Next.js `after`), by `npm run worker`,
 * or by the cron endpoint. Each job is claimed by exactly one worker; failures are retried with
 * exponential backoff.
 */

/** Job errors can contain internals; users see one of these instead. */
export function describeJobFailure(error: unknown): string {
  if (error instanceof PermanentJobError) return error.message
  if (error instanceof AiProviderError && error.dailyQuota) return DAILY_QUOTA_MESSAGE
  const status = error instanceof AiProviderError ? error.status : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (status === 429 || /\(429\)/.test(message)) return 'The AI service kept rate-limiting requests. Please try again in a few minutes.'
  if ((status !== undefined && status >= 500) || /\((5\d\d|timeout|network)\)/.test(message)) {
    return 'The AI service was temporarily unavailable. Please try again shortly.'
  }
  return 'Something went wrong while processing this in the background. Please try again later.'
}

/** Shown while a job waits for its next attempt, instead of the step it was on. */
export function describeRetry(error: unknown, delaySeconds: number): string {
  const status = error instanceof AiProviderError ? error.status : undefined
  const message = error instanceof Error ? error.message : String(error)
  const wait = delaySeconds >= 120 ? `${Math.round(delaySeconds / 60)} min` : `${Math.max(1, Math.round(delaySeconds))} s`
  if (status === 429 || /\(429\)/.test(message)) return `AI service busy — retrying in ~${wait}`
  return `Temporary error — retrying in ~${wait}`
}

/** Items that show progress text say why they are waiting for the next attempt. */
async function reportRetry(job: JobRecord, context: JobContext, error: unknown, delaySeconds: number) {
  try {
    await JOBS[job.type].onRetry(job.payload, context, describeRetry(error, delaySeconds))
  } catch (failure) {
    log.error('Could not record job retry', failure, { jobId: job.id })
  }
}

/** Once a job is out of retries, make the failure visible where the user is looking. */
async function reportFailure(job: JobRecord, context: JobContext, error: unknown) {
  try {
    await JOBS[job.type].onFailure(job.payload, context, describeJobFailure(error), error)
  } catch (failure) {
    log.error('Could not record permanent job failure', failure, { jobId: job.id })
  }
}

export function retryDelaySeconds(attempt: number): number {
  return Math.min(300, 10 * 2 ** Math.max(0, attempt - 1))
}

export async function runJobs(
  context: JobContext,
  options: {
    maxJobs?: number
    timeBudgetMs?: number
    types?: readonly JobType[]
    /** Checked before each claim: a stopping worker finishes its current job but takes no new one. */
    shouldStop?: () => boolean
  } = {},
): Promise<{ processed: number; failed: number }> {
  const maxJobs = options.maxJobs ?? 5
  const deadline = Date.now() + (options.timeBudgetMs ?? 50_000)
  let processed = 0
  let failed = 0
  // Scheduled connector syncs become ordinary jobs.
  try {
    await queueDueSyncs(context.repos, JOB_ATTEMPTS.sync_connector)
  } catch (error) {
    log.error('Could not queue scheduled syncs', error)
  }

  while (processed + failed < maxJobs && Date.now() < deadline && !options.shouldStop?.()) {
    const job = await context.repos.jobs.claim(options.types)
    if (!job) break
    try {
      await JOBS[job.type].run(job.payload, context, deadline)
      await context.repos.jobs.complete(job.id)
      processed++
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : String(error)
      // Honour the vendor's requested wait (quota reset) when it is longer than our backoff.
      const requested = error instanceof AiProviderError && error.retryAfterSeconds !== undefined ? Math.ceil(error.retryAfterSeconds) + 1 : 0
      const delay = Math.max(retryDelaySeconds(job.attempts), requested)
      // Retrying cannot fix a used-up daily quota, a rejected key or an invalid request: fail now, clearly.
      const permanent = error instanceof PermanentJobError || (error instanceof AiProviderError && !error.retryable)
      const status = await context.repos.jobs.fail(job.id, message, delay, permanent)
      log.warn('Background job failed', { jobId: job.id, type: job.type, attempt: job.attempts, status, error: message })
      if (status === 'failed') await reportFailure(job, context, error)
      else await reportRetry(job, context, error, delay)
    }
  }
  return { processed, failed }
}
