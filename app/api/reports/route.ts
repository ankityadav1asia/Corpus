import { LIMITS } from '@/lib/constants'
import { reportCreateSchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { collectionAccess, requireWorkspacePermission } from '@/server/auth/access'
import { readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { TEMPLATE_LABELS } from '@/server/reports/generate'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

/** Reports of the workspace, newest first (shared with every member). */
export const GET = workspaceRoute(async ({ access }) => {
  const reports = await getServices().repos.reports.list(access.workspaceId)
  // The list polls while reports are written: keep the queue moving (retries included).
  if (reports.some((report) => report.status === 'queued' || report.status === 'running')) processJobsAfterResponse()
  return json({ reports })
})

/**
 * Queues a multi-document synthesis (any member — it only reads content they can already see).
 * Returns 202 immediately; the report is written in the background and polled by the UI.
 */
export const POST = workspaceRoute(async ({ req, access }) => {
  requireWorkspacePermission(access, 'reports.create')
  const input = await readJson(req, reportCreateSchema, 16 * 1024)
  const services = getServices()
  services.ai() // fail fast with 503 when AI is not configured
  await enforceRateLimit(services.repos, `reports:user:${access.userId}`, RATE_LIMITS.reports)

  for (const collectionId of input.collectionIds) await collectionAccess(services.repos, access, collectionId)
  const documents = await services.repos.documents.resolveReportDocuments(
    access.workspaceId,
    { collectionIds: input.collectionIds, documentIds: input.documentIds },
    LIMITS.documentsPerReport,
  )
  if (documents.length === 0) throw Errors.badRequest('The selection has no indexed documents yet.')

  const report = await services.repos.reports.create({
    workspaceId: access.workspaceId,
    createdBy: access.userId,
    template: input.template,
    format: input.template === 'slide_outline' ? input.format : 'markdown',
    title: input.title || `${TEMPLATE_LABELS[input.template]} — ${documents.length} document${documents.length === 1 ? '' : 's'}`,
    instructions: input.instructions ?? null,
    collectionIds: input.collectionIds,
    documentIds: input.documentIds,
  })
  await services.repos.jobs.enqueue('generate_report', { reportId: report.id }, { maxAttempts: JOB_ATTEMPTS.generate_report })
  await recordAudit(services.repos, access, 'report.created', { type: 'report', id: report.id }, { title: report.title, template: report.template })
  processJobsAfterResponse()
  return json({ report }, { status: 202 })
})
