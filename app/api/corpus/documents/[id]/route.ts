import { idSchema, type DocumentDetail } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireCollectionPermission } from '@/server/auth/access'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

type Params = { id: string }

/** Largest number of chunks returned when reading a document in full. */
const MAX_CHUNKS = 2_000

/** A document with its chunks in order — the source viewer (any member who can see the notebook). */
export const GET = workspaceRoute<Params>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  const detail = await repos.documents.detail(access.workspaceId, id, MAX_CHUNKS)
  if (!detail) throw Errors.notFound('Document')
  await requireCollectionPermission(repos, access, detail.document.collectionId, 'collection.view')
  return json<DocumentDetail>({ ...detail, file: await repos.media.fileInfo(access.workspaceId, id) })
})

/** Removes a document and all of its chunks (Editor of its notebook). */
export const DELETE = workspaceRoute<Params>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  const document = await repos.documents.get(access.workspaceId, id)
  if (!document) throw Errors.notFound('Document')
  await requireCollectionPermission(repos, access, document.collectionId, 'collection.editChunks')
  if (!(await repos.documents.delete(access.workspaceId, id))) throw Errors.notFound('Document')
  await recordAudit(repos, access, 'document.deleted', { type: 'document', id }, { title: document.title })
  return json({ ok: true })
})
