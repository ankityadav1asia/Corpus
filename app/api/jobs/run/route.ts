import type { NextRequest } from 'next/server'

import { getCronSecret } from '@/server/env'
import { Errors } from '@/server/http/errors'
import { json, publicRoute } from '@/server/http/route'
import { runJobs } from '@/server/jobs/runner'
import { jobContextFrom } from '@/server/jobs/trigger'
import { secretsEqual } from '@/server/security/compare'
import { getServices } from '@/server/services'

export const maxDuration = 60

function authorized(req: NextRequest, secret: string): boolean {
  return secretsEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`)
}

/**
 * Drains the background job queue. Meant for a scheduler (e.g. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`). Returns 404 unless CRON_SECRET is configured.
 */
async function handle(req: NextRequest) {
  const secret = getCronSecret()
  if (!secret) throw Errors.notFound('Endpoint')
  if (!authorized(req, secret)) throw Errors.unauthenticated()
  const services = getServices()
  const result = await runJobs(jobContextFrom(services), { maxJobs: 20, timeBudgetMs: 50_000 })
  await services.repos.jobs.purgeFinished(7).catch(() => 0)
  return json(result)
}

export const GET = publicRoute(async ({ req }) => handle(req))
export const POST = publicRoute(async ({ req }) => handle(req))
