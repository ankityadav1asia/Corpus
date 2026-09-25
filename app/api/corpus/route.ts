import { clearCollectionQuerySchema, documentsQuerySchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireCollectionPermission } from '@/server/auth/access'
import { readSearchParams } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { getServices } from '@/server/services'

/** Documents in one notebook, or in the whole workspace (any member). */
export const GET = workspaceRoute(async ({ req, access }) => {
  const { collectionId } = readSearchParams(req, documentsQuerySchema)
  const { repos } = getServices()
  if (collectionId) await requireCollectionPermission(repos, access, collectionId, 'collection.view')
  const documents = await repos.documents.list(access.workspaceId, collectionId)
  // The sources list polls while documents are indexing; keep the queue moving meanwhile.
  if (documents.some((document) => document.status === 'processing')) processJobsAfterResponse()
  return json({ documents })
})

/** Removes every document from one notebook (notebook Admin). There is no "wipe everything". */
export const DELETE = workspaceRoute(async ({ req, access }) => {
  const { collectionId } = readSearchParams(req, clearCollectionQuerySchema)
  const { repos } = getServices()
  const { collection } = await requireCollectionPermission(repos, access, collectionId, 'collection.manage')
  const deleted = await repos.documents.clearCollection(access.workspaceId, collectionId)
  await recordAudit(repos, access, 'notebook.cleared', { type: 'notebook', id: collectionId }, { name: collection.name, documents: deleted })
  return json({ deleted })
})
