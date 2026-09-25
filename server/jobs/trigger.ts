import 'server-only'

import { after } from 'next/server'

import { runJobs, type JobContext } from '@/server/jobs/runner'
import { getSecretKeys, webRunsJobs } from '@/server/env'
import { log } from '@/server/logger'
import { getServices, type Services } from '@/server/services'

/** Everything a job may need, from the composition root. */
export function jobContextFrom(services: Services): JobContext {
  return {
    repos: services.repos,
    ai: services.ai,
    reranker: services.reranker,
    images: services.images,
    vision: services.vision,
    transcriber: services.transcriber,
    speech: services.speech,
    ocr: services.ocr,
    connectors: services.connectors,
    secret: getSecretKeys,
    fetch: services.fetch?.(),
  }
}

let autorun = true
// One runner per server instance: parallel runners would only compete for the same model quota.
let running = false

/** Tests process jobs explicitly instead. */
export function setJobAutorun(enabled: boolean) {
  autorun = enabled
}

/**
 * Processes queued jobs once the current response has been sent (Next.js `after`, which on
 * serverless keeps the function alive for it). Called after requests that queue work and by the
 * endpoints the UI polls while waiting for results, so retries make progress while someone is
 * waiting. Jobs are durable in Postgres; anything left is picked up by `npm run worker` or the
 * /api/jobs/run cron endpoint. With WEB_RUNS_JOBS=false only those do the work.
 */
export function processJobsAfterResponse() {
  if (!autorun || !webRunsJobs()) return
  const run = async () => {
    if (running) return
    running = true
    try {
      const services = getServices()
      await runJobs(jobContextFrom(services), { maxJobs: 5, timeBudgetMs: 50_000 })
    } catch (error) {
      log.error('Background job processing failed', error)
    } finally {
      running = false
    }
  }
  try {
    after(run)
  } catch {
    // Outside a request scope (scripts): run detached.
    void run()
  }
}
