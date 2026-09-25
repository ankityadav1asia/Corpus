import { collectionInputSchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireWorkspacePermission, withMyRole } from '@/server/auth/access'
import { readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

const MAX_COLLECTIONS_PER_WORKSPACE = 100

/** Every notebook of the workspace, with the caller's effective role on each. */
export const GET = workspaceRoute(async ({ access }) => {
  const records = await getServices().repos.collections.list(access.workspaceId, access.userId)
  return json({ collections: records.map((record) => withMyRole(access, record)) })
})

export const POST = workspaceRoute(async ({ req, access }) => {
  requireWorkspacePermission(access, 'collection.create')
  const { name } = await readJson(req, collectionInputSchema)
  const { repos } = getServices()
  if ((await repos.collections.count(access.workspaceId)) >= MAX_COLLECTIONS_PER_WORKSPACE) {
    throw Errors.conflict(`A workspace can have at most ${MAX_COLLECTIONS_PER_WORKSPACE} notebooks.`)
  }
  const record = await repos.collections.create(access.workspaceId, access.userId, name)
  if (!record) throw Errors.conflict('This workspace already has a notebook with that name.')
  await recordAudit(repos, access, 'notebook.created', { type: 'notebook', id: record.id }, { name })
  return json({ collection: withMyRole(access, record) }, { status: 201 })
})
