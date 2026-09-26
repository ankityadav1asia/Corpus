import 'server-only'

import { LIMITS } from '@/lib/constants'
import type { UploadFileResult, UploadStarted } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireCollectionPermission, type WorkspaceAccess } from '@/server/auth/access'
import { Errors, isAppError } from '@/server/http/errors'
import { checkUploadFile, readUpload } from '@/server/ingestion/extractors'
import { keepOriginalPdf, queueDocument, queueMedia } from '@/server/ingestion/ingest-service'
import { prepareIngest } from '@/server/ingestion/prepare'
import { log } from '@/server/logger'
import type { Repositories } from '@/server/repositories'
import type { UploadSessionRecord } from '@/server/repositories/uploads'

/** How long an upload in parts may take; the parts of an unfinished upload are discarded afterwards. */
const UPLOAD_TTL_MS = 60 * 60 * 1000

/**
 * One uploaded file → a queued document. Text formats are extracted now; images, audio, video and
 * scanned PDFs are stored for a background job. A file that cannot be used is reported with a reason
 * rather than thrown, so one bad file does not fail the rest of a batch.
 */
export async function ingestUploadedFile(repos: Repositories, access: WorkspaceAccess, collectionId: string, file: File): Promise<UploadFileResult> {
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
    return { filename: file.name, status: 'queued', document }
  } catch (error) {
    if (!isAppError(error)) log.error('File ingestion failed', error, { file: file.name })
    return { filename: file.name, status: 'error', error: isAppError(error) ? error.message : 'Processing failed.' }
  }
}

/* ── Uploads in parts ───────────────────────────────────────────────────────────
 * For files larger than one request body (serverless hosts cap bodies, Vercel at 4.5 MB):
 * start → PUT each part (any order, retries welcome) → complete, which ingests the file exactly
 * like a one-request upload. Only the uploader can see, add to, complete or cancel an upload.
 */

const partCount = (session: UploadSessionRecord) => Math.ceil(session.byteSize / session.partBytes)

/** Checks the file (name, size) and the caller's rights before any byte is sent. */
export async function startUpload(access: WorkspaceAccess, input: { collectionId: string; fileName: string; byteSize: number }): Promise<UploadStarted> {
  checkUploadFile(input.fileName, input.byteSize)
  const { repos } = await prepareIngest(access, input.collectionId)
  await repos.uploads.purgeExpired()
  if ((await repos.uploads.openCount(access.workspaceId, access.userId)) >= LIMITS.openUploads) {
    throw Errors.conflict(`You have ${LIMITS.openUploads} uploads in progress. Wait for them to finish, then try again.`)
  }
  const session = await repos.uploads.create({
    workspaceId: access.workspaceId,
    collectionId: input.collectionId,
    createdBy: access.userId,
    fileName: input.fileName,
    byteSize: input.byteSize,
    partBytes: LIMITS.uploadPartBytes,
    expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
  })
  return { uploadId: session.id, partBytes: session.partBytes, parts: partCount(session), expiresAt: session.expiresAt }
}

async function ownUpload(repos: Repositories, access: WorkspaceAccess, uploadId: string): Promise<UploadSessionRecord> {
  const session = await repos.uploads.get(access.workspaceId, access.userId, uploadId)
  if (!session) throw Errors.notFound('Upload')
  return session
}

/** Stores one part. Every part but the last is exactly `partBytes` long, so the pieces line up. */
export async function receivePart(repos: Repositories, access: WorkspaceAccess, target: { uploadId: string; index: number }, bytes: Uint8Array): Promise<void> {
  const session = await ownUpload(repos, access, target.uploadId)
  const parts = partCount(session)
  if (target.index >= parts) throw Errors.badRequest(`This upload has ${parts} part(s), numbered from 0.`)
  const expected = Math.min(session.partBytes, session.byteSize - target.index * session.partBytes)
  if (bytes.byteLength !== expected) throw Errors.badRequest(`Part ${target.index} must be exactly ${expected} bytes (received ${bytes.byteLength}).`)
  await repos.uploads.putPart(session.id, target.index, bytes)
}

/** Reassembles the file and ingests it. The parts are removed first, so a second completion finds nothing. */
export async function completeUpload(repos: Repositories, access: WorkspaceAccess, uploadId: string): Promise<UploadFileResult> {
  const session = await ownUpload(repos, access, uploadId)
  // The role may have changed since the upload started.
  await requireCollectionPermission(repos, access, session.collectionId, 'collection.ingest')
  const received = await repos.uploads.receivedBytes(session.id)
  if (received !== session.byteSize) {
    throw Errors.conflict(`The upload is incomplete: ${received} of ${session.byteSize} bytes arrived. Send the missing parts, then complete it again.`)
  }
  const bytes = await repos.uploads.bytes(session.id)
  if (!(await repos.uploads.delete(access.workspaceId, access.userId, session.id))) throw Errors.notFound('Upload')
  return ingestUploadedFile(repos, access, session.collectionId, new File([bytes], session.fileName))
}

/** Cancels an upload and discards the parts received so far. */
export async function abortUpload(repos: Repositories, access: WorkspaceAccess, uploadId: string): Promise<void> {
  if (!(await repos.uploads.delete(access.workspaceId, access.userId, uploadId))) throw Errors.notFound('Upload')
}
