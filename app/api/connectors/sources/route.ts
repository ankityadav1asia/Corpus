import { connectorSourceCreateSchema, type ConnectorSourceSummary } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireCollectionPermission, requireWorkspacePermission } from '@/server/auth/access'
import { connectorFor } from '@/server/connectors/service'
import { readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

/**
 * Adds Google Drive files and folders to a notebook (Editor on that notebook) and queues their first
 * sync. Accounts can only be used by their owner.
 */
export const POST = workspaceRoute(async ({ req, access }) => {
  requireWorkspacePermission(access, 'connectors.use')
  const input = await readJson(req, connectorSourceCreateSchema, 64 * 1024)
  const services = getServices()
  await enforceRateLimit(services.repos, `connectors:user:${access.userId}`, RATE_LIMITS.connectorSync)
  await requireCollectionPermission(services.repos, access, input.collectionId, 'collection.ingest')
  connectorFor(services, input.provider)

  const connection = await services.repos.connectors.getConnection(access.workspaceId, input.connectionId)
  if (!connection || connection.userId !== access.userId || connection.provider !== input.provider) throw Errors.notFound('Connection')

  const sources: ConnectorSourceSummary[] = []
  for (const item of input.items) {
    const source = await services.repos.connectors.saveSource({
      workspaceId: access.workspaceId,
      collectionId: input.collectionId,
      connectionId: input.connectionId,
      createdBy: access.userId,
      provider: input.provider,
      kind: item.kind,
      externalId: item.externalId,
      name: item.name,
      url: null,
      options: {},
      autoSync: input.autoSync,
      syncIntervalHours: input.syncIntervalHours,
    })
    if (!(await services.repos.jobs.hasActive('sync_connector', { sourceId: source.id }))) {
      await services.repos.jobs.enqueue('sync_connector', { sourceId: source.id }, { maxAttempts: JOB_ATTEMPTS.sync_connector })
    }
    await recordAudit(services.repos, access, 'connector.source_added', { type: 'connector_source', id: source.id }, { provider: input.provider, name: source.name })
    sources.push(source)
  }
  processJobsAfterResponse()
  return json<{ sources: ConnectorSourceSummary[] }>({ sources }, { status: 202 })
})
