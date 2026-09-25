import { connectorSourceUpdateSchema, idSchema, type ConnectorSourceSummary } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireCollectionPermission } from '@/server/auth/access'
import { parseWith, readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

type Params = { id: string }

/** Turns scheduled sync on/off or changes its interval (Editor on the notebook). */
export const PATCH = workspaceRoute<Params>(async ({ req, params, access }) => {
  const id = parseWith(idSchema, params.id)
  const changes = await readJson(req, connectorSourceUpdateSchema, 4 * 1024)
  const { repos } = getServices()
  const source = await repos.connectors.getSource(access.workspaceId, id)
  if (!source) throw Errors.notFound('Synced source')
  await requireCollectionPermission(repos, access, source.collectionId, 'collection.ingest')
  const updated = await repos.connectors.updateSource(access.workspaceId, id, changes)
  if (!updated) throw Errors.notFound('Synced source')
  return json<{ source: ConnectorSourceSummary }>({ source: updated })
})

/** Stops syncing (Editor on the notebook). `?documents=delete` also removes what it imported. */
export const DELETE = workspaceRoute<Params>(async ({ req, params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  const source = await repos.connectors.getSource(access.workspaceId, id)
  if (!source) throw Errors.notFound('Synced source')
  await requireCollectionPermission(repos, access, source.collectionId, 'collection.ingest')
  const withDocuments = req.nextUrl.searchParams.get('documents') === 'delete'
  await repos.connectors.deleteSource(access.workspaceId, id, withDocuments)
  await recordAudit(repos, access, 'connector.source_removed', { type: 'connector_source', id }, { name: source.name, documentsRemoved: withDocuments })
  return json({ ok: true })
})
