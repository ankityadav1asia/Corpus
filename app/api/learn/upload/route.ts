import { LIMITS } from '@/lib/constants'
import { idSchema, type UploadResult } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { parseWith, readFormData } from '@/server/http/body'
import { Errors, isAppError } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { readUpload } from '@/server/ingestion/extractors'
import { keepOriginalPdf, queueDocument, queueMedia } from '@/server/ingestion/ingest-service'
import { prepareIngest } from '@/server/ingestion/prepare'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { log } from '@/server/logger'

// Text extraction of a large PDF happens here; OCR, transcription and embedding run in the background.
export const maxDuration = 120

/**
 * Multipart upload (field `files`, repeated; up to 50 MB per file). The whole body is capped before
 * it is parsed. Text formats are extracted now, so unreadable files fail immediately with a reason.
 * Images, audio, video and scanned PDFs are stored and read by a background job (vision / OCR /
 * transcription). Either way indexing is queued (202) and reported through the document status.
 */
export const POST = workspaceRoute(async ({ req, access }) => {
  const form = await readFormData(req, LIMITS.uploadBytes)
  const collectionId = parseWith(idSchema, form.get('collectionId'))
  const files = form.getAll('files').filter((value): value is File => value instanceof File)
  if (files.length === 0) throw Errors.badRequest('Choose at least one file to upload.')
  if (files.length > LIMITS.filesPerUpload) throw Errors.badRequest(`Upload at most ${LIMITS.filesPerUpload} files at a time.`)

  const { repos } = await prepareIngest(access, collectionId)
  const results: UploadResult['results'] = []
  for (const file of files) {
    try {
      const content = await readUpload(file)
      const base = { workspaceId: access.workspaceId, createdBy: access.userId, collectionId, sourceType: 'file' as const, replaceExisting: true, byteSize: file.size }
      const document =
        content.type === 'text'
          ? await queueDocument(repos, { ...base, source: content.document.source, title: content.document.title, text: content.document.text })
          : await queueMedia(
              repos,
              { ...base, source: content.source, title: content.title },
              { kind: content.kind, mimeType: content.mimeType, fileName: file.name, data: content.data, pageCount: content.pageCount, pages: content.pages },
            )
      await keepOriginalPdf(repos, document.id, file.name, new Uint8Array(await file.arrayBuffer()))
      await recordAudit(
        repos,
        access,
        'source.added',
        { type: 'document', id: document.id },
        { title: document.title, sourceType: 'file', bytes: file.size, ...(content.type === 'media' ? { media: content.kind } : {}) },
      )
      results.push({ filename: file.name, status: 'queued', document })
    } catch (error) {
      if (!isAppError(error)) log.error('File ingestion failed', error, { file: file.name })
      results.push({ filename: file.name, status: 'error', error: isAppError(error) ? error.message : 'Processing failed.' })
    }
  }
  const anyQueued = results.some((result) => result.status === 'queued')
  if (anyQueued) processJobsAfterResponse()
  return json<UploadResult>({ results }, { status: anyQueued ? 202 : 422 })
})
