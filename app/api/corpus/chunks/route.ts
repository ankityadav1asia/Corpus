import { chunksQuerySchema } from '@/lib/contracts'
import { requireCollectionPermission } from '@/server/auth/access'
import { readSearchParams } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/** Paginated chunk explorer (any member). Filters: notebook, document, label, literal text search. */
export const GET = workspaceRoute(async ({ req, access }) => {
  const query = readSearchParams(req, chunksQuerySchema)
  const { repos } = getServices()
  if (query.collectionId) await requireCollectionPermission(repos, access, query.collectionId, 'collection.view')
  return json(await repos.chunks.list({ workspaceId: access.workspaceId, ...query }))
})
