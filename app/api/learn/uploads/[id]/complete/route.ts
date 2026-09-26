import { idSchema, type UploadResult } from '@/lib/contracts'
import { parseWith } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { completeUpload } from '@/server/ingestion/uploads'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { getServices } from '@/server/services'

// Reassembling and extracting a large PDF happens here, then queued work runs after the response.
export const maxDuration = 300

/**
 * Completes an upload in parts once every part has arrived (409 otherwise). The file is then
 * ingested exactly like a one-request upload, with the same response (202, or 422 with a reason).
 */
export const POST = workspaceRoute<{ id: string }>(async ({ params, access }) => {
  const result = await completeUpload(getServices().repos, access, parseWith(idSchema, params.id))
  const queued = result.status === 'queued'
  if (queued) processJobsAfterResponse()
  return json<UploadResult>({ results: [result] }, { status: queued ? 202 : 422 })
})
