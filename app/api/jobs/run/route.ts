import type { NextRequest } from 'next/server'

import { purgeGuests } from '@/server/auth/demo'
import { getCronSecret } from '@/server/env'
import { Errors } from '@/server/http/errors'
import { json, publicRoute } from '@/server/http/route'
import { runJobs } from '@/server/jobs/runner'
import { jobContextFrom } from '@/server/jobs/trigger'
import { secretsEqual } from '@/server/security/compare'
import { getServices } from '@/server/services'

// 300 s is the most Vercel allows on the Hobby plan. The queue is drained for a minute less, which
// leaves room for a job step that runs over.
export const maxDuration = 300
const TIME_BUDGET_MS = (maxDuration - 60) * 1000

function authorized(req: NextRequest, secret: string): boolean {
  return secretsEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`)
}

/**
 * Drains the background job queue and does the housekeeping. Meant for a scheduler: Vercel Cron
 * (vercel.json) sends `Authorization: Bearer $CRON_SECRET`. Returns 404 unless CRON_SECRET is configured.
 */
async function handle(req: NextRequest) {
  const secret = getCronSecret()
  if (!secret) throw Errors.notFound('Endpoint')
  if (!authorized(req, secret)) throw Errors.unauthenticated()
  const services = getServices()
  const result = await runJobs(jobContextFrom(services), { maxJobs: 50, timeBudgetMs: TIME_BUDGET_MS })
  await services.repos.jobs.purgeFinished(7).catch(() => 0)
  await services.repos.uploads.purgeExpired().catch(() => 0)
  await purgeGuests(services.repos).catch(() => 0)
  return json(result)
}

export const GET = publicRoute(async ({ req }) => handle(req))
export const POST = publicRoute(async ({ req }) => handle(req))
