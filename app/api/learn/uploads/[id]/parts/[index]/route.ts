import { LIMITS } from '@/lib/constants'
import { uploadPartParamsSchema } from '@/lib/contracts'
import { parseWith, readBodyBytes } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { receivePart } from '@/server/ingestion/uploads'
import { getServices } from '@/server/services'

/**
 * One part of an upload (raw bytes, at most LIMITS.uploadPartBytes). Parts may arrive in any order,
 * and sending a part again replaces it, so the client can retry after a network error.
 */
export const PUT = workspaceRoute<{ id: string; index: string }>(async ({ req, params, access }) => {
  const { id, index } = parseWith(uploadPartParamsSchema, params)
  const bytes = await readBodyBytes(req, LIMITS.uploadPartBytes)
  await receivePart(getServices().repos, access, { uploadId: id, index }, bytes)
  return json({ received: bytes.byteLength })
})
