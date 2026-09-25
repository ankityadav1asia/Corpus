import { idSchema } from '@/lib/contracts'
import { requireCollectionPermission } from '@/server/auth/access'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

/** Syncs a source now (Editor on its notebook). A sync already queued or running is not duplicated. */
export const POST = workspaceRoute<{ id: string }>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  const source = await repos.connectors.getSource(access.workspaceId, id)
  if (!source) throw Errors.notFound('Synced source')
  await requireCollectionPermission(repos, access, source.collectionId, 'collection.ingest')
  await enforceRateLimit(repos, `connectors:user:${access.userId}`, RATE_LIMITS.connectorSync)
  if (!(await repos.jobs.hasActive('sync_connector', { sourceId: id }))) {
    await repos.connectors.setSourceStatus(id, 'queued', null)
    await repos.jobs.enqueue('sync_connector', { sourceId: id }, { maxAttempts: JOB_ATTEMPTS.sync_connector })
  }
  processJobsAfterResponse()
  return json({ ok: true }, { status: 202 })
})
