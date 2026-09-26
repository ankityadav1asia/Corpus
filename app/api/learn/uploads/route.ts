import { startUploadSchema, type UploadStarted } from '@/lib/contracts'
import { readJson } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { startUpload } from '@/server/ingestion/uploads'

/**
 * Starts an upload in parts, for files larger than one request body (serverless hosts cap bodies,
 * Vercel at 4.5 MB): PUT each part to /api/learn/uploads/:id/parts/:index, then POST
 * /api/learn/uploads/:id/complete. The file name, size and the caller's rights are checked here,
 * before any byte is sent (Editors and Admins of the notebook).
 */
export const POST = workspaceRoute(async ({ req, access }) => {
  const input = await readJson(req, startUploadSchema)
  return json<UploadStarted>(await startUpload(access, input), { status: 201 })
})
