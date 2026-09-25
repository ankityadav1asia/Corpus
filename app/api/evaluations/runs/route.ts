import { recordAudit } from '@/server/activity'
import { requireWorkspacePermission } from '@/server/auth/access'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

export const GET = workspaceRoute(async ({ access }) => {
  const runs = await getServices().repos.evaluations.runs(access.workspaceId)
  // Polled while a run is in progress: long benchmarks continue in follow-up jobs.
  if (runs.some((run) => run.status === 'queued' || run.status === 'running')) processJobsAfterResponse()
  return json({ runs })
})

/**
 * Starts a benchmark run in the background (Editor): every question goes through the live
 * pipeline and is scored against its reference answer, including context recall.
 */
export const POST = workspaceRoute(async ({ access }) => {
  requireWorkspacePermission(access, 'evaluation.manage')
  const services = getServices()
  services.ai() // fail fast with 503 when AI is not configured
  await enforceRateLimit(services.repos, `benchmark:user:${access.userId}`, RATE_LIMITS.benchmarks)

  const [cases, [latest]] = await Promise.all([services.repos.evaluations.caseCount(access.workspaceId), services.repos.evaluations.runs(access.workspaceId, 1)])
  if (cases === 0) throw Errors.badRequest('Add at least one benchmark question first.')
  if (latest && (latest.status === 'queued' || latest.status === 'running')) throw Errors.conflict('A benchmark run is already in progress.')

  const run = await services.repos.evaluations.createRun(access.workspaceId, access.userId, cases)
  await services.repos.jobs.enqueue('run_benchmark', { runId: run.id }, { maxAttempts: JOB_ATTEMPTS.run_benchmark })
  await recordAudit(services.repos, access, 'benchmark.started', { type: 'benchmark_run', id: run.id }, { questions: cases })
  processJobsAfterResponse()
  return json({ run }, { status: 202 })
})
