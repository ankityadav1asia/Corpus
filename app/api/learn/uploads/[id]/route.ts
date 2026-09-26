import { idSchema } from '@/lib/contracts'
import { parseWith } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { abortUpload } from '@/server/ingestion/uploads'
import { getServices } from '@/server/services'

/** Cancels the caller's upload in parts and discards the parts received so far. */
export const DELETE = workspaceRoute<{ id: string }>(async ({ params, access }) => {
  await abortUpload(getServices().repos, access, parseWith(idSchema, params.id))
  return json({ ok: true })
})
