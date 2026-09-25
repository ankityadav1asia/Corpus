import { collectionInputSchema, idSchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireCollectionPermission } from '@/server/auth/access'
import { parseWith, readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

type Params = { id: string }

/** Rename (notebook Admin). */
export const PATCH = workspaceRoute<Params>(async ({ req, params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { name } = await readJson(req, collectionInputSchema)
  const { repos } = getServices()
  const { collection } = await requireCollectionPermission(repos, access, id, 'collection.manage')
  const result = await repos.collections.rename(access.workspaceId, id, name)
  if (result === 'not_found') throw Errors.notFound('Notebook')
  if (result === 'conflict') throw Errors.conflict('This workspace already has a notebook with that name.')
  await recordAudit(repos, access, 'notebook.renamed', { type: 'notebook', id }, { from: collection.name, to: name })
  return json({ ok: true })
})

/** Deletes the notebook with all of its documents and chunks (notebook Admin). Conversations are kept. */
export const DELETE = workspaceRoute<Params>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  const { collection } = await requireCollectionPermission(repos, access, id, 'collection.manage')
  if (!(await repos.collections.delete(access.workspaceId, id))) throw Errors.notFound('Notebook')
  await recordAudit(repos, access, 'notebook.deleted', { type: 'notebook', id }, { name: collection.name })
  return json({ ok: true })
})
