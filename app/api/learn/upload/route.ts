import { LIMITS } from '@/lib/constants'
import { idSchema, type UploadResult } from '@/lib/contracts'
import { parseWith, readFormData } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { prepareIngest } from '@/server/ingestion/prepare'
import { ingestUploadedFile } from '@/server/ingestion/uploads'
import { processJobsAfterResponse } from '@/server/jobs/trigger'

// Text extraction of a large PDF happens here, then queued work runs after the response (Next.js after).
export const maxDuration = 300

/**
 * Multipart upload (field `files`, repeated; up to 50 MB per file). The whole body is capped before
 * it is parsed. Text formats are extracted now, so unreadable files fail immediately with a reason.
 * Images, audio, video and scanned PDFs are stored and read by a background job (vision / OCR /
 * transcription). Either way indexing is queued (202) and reported through the document status.
 * Serverless hosts cap request bodies (Vercel at 4.5 MB): the UI sends larger files in parts
 * (POST /api/learn/uploads).
 */
export const POST = workspaceRoute(async ({ req, access }) => {
  const form = await readFormData(req, LIMITS.uploadBytes)
  const collectionId = parseWith(idSchema, form.get('collectionId'))
  const files = form.getAll('files').filter((value): value is File => value instanceof File)
  if (files.length === 0) throw Errors.badRequest('Choose at least one file to upload.')
  if (files.length > LIMITS.filesPerUpload) throw Errors.badRequest(`Upload at most ${LIMITS.filesPerUpload} files at a time.`)

  const { repos } = await prepareIngest(access, collectionId)
  const results: UploadResult['results'] = []
  for (const file of files) results.push(await ingestUploadedFile(repos, access, collectionId, file))
  const anyQueued = results.some((result) => result.status === 'queued')
  if (anyQueued) processJobsAfterResponse()
  return json<UploadResult>({ results }, { status: anyQueued ? 202 : 422 })
})
