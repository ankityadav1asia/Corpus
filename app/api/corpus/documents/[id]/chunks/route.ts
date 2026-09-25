import { chunkCreateSchema, idSchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { appendChunk } from '@/server/corpus/chunk-editor'
import { parseWith, readJson } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

/** Adds a hand-written chunk to the end of a document (Editor). It is embedded immediately. */
export const POST = workspaceRoute<{ id: string }>(async ({ req, params, access }) => {
  const documentId = parseWith(idSchema, params.id)
  const input = await readJson(req, chunkCreateSchema, 32 * 1024)
  const services = getServices()
  await enforceRateLimit(services.repos, `chunk-edit:user:${access.userId}`, RATE_LIMITS.chunkEdit)
  const chunk = await appendChunk({ repos: services.repos, ai: services.ai }, access, documentId, input)
  await recordAudit(services.repos, access, 'chunk.added', { type: 'chunk', id: chunk.id }, { document: chunk.documentTitle })
  return json({ chunk }, { status: 201 })
})
