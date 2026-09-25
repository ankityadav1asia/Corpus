import { chunkUpdateSchema, idSchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { deleteChunk, updateChunk } from '@/server/corpus/chunk-editor'
import { parseWith, readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

type Params = { id: string }

/** One chunk with labels, metadata and a summary of its vector (any member). */
export const GET = workspaceRoute<Params>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const chunk = await getServices().repos.chunks.get(access.workspaceId, id)
  if (!chunk) throw Errors.notFound('Chunk')
  return json({ chunk })
})

/** Edit text (re-embedded), labels and/or metadata (Editor of the chunk's notebook). */
export const PATCH = workspaceRoute<Params>(async ({ req, params, access }) => {
  const id = parseWith(idSchema, params.id)
  const changes = await readJson(req, chunkUpdateSchema, 32 * 1024)
  const services = getServices()
  await enforceRateLimit(services.repos, `chunk-edit:user:${access.userId}`, RATE_LIMITS.chunkEdit)
  const chunk = await updateChunk({ repos: services.repos, ai: services.ai }, access, id, changes)
  await recordAudit(services.repos, access, 'chunk.edited', { type: 'chunk', id }, { document: chunk.documentTitle, fields: Object.keys(changes) })
  return json({ chunk })
})

/** Deletes the chunk — text and vector live in the same row, so both go at once (Editor). */
export const DELETE = workspaceRoute<Params>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const services = getServices()
  await deleteChunk({ repos: services.repos, ai: services.ai }, access, id)
  await recordAudit(services.repos, access, 'chunk.deleted', { type: 'chunk', id })
  return json({ ok: true })
})
