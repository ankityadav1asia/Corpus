import { recordAudit } from '@/server/activity'
import { requireWorkspacePermission } from '@/server/auth/access'
import { Errors } from '@/server/http/errors'
import { json, workspaceParamRoute } from '@/server/http/route'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { getServices } from '@/server/services'

/**
 * Re-embeds every passage of the workspace that was embedded by another model (workspace Admin).
 * Needed after switching EMBEDDING_PROVIDER / model: until then those passages are found by keyword
 * search only.
 */
export const POST = workspaceParamRoute(async ({ access }) => {
  const services = getServices()
  requireWorkspacePermission(access, 'workspace.manage')
  const workspaceId = access.workspaceId
  const model = services.ai().embeddingModel
  const { stale } = await services.repos.chunks.embeddingStatus(workspaceId, model)
  if (stale === 0) throw Errors.conflict('Every passage already uses the active embedding model.')
  if (!(await services.repos.jobs.hasActive('reembed_workspace', { workspaceId }))) {
    await services.repos.jobs.enqueue('reembed_workspace', { workspaceId }, { maxAttempts: JOB_ATTEMPTS.reembed_workspace })
    await recordAudit(services.repos, access, 'workspace.reembed_started', { type: 'workspace', id: workspaceId }, { passages: stale, model })
  }
  processJobsAfterResponse()
  return json({ queued: stale }, { status: 202 })
})
