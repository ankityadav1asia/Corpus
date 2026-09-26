import { WORKSPACE_HEADER, getActiveWorkspaceId, notifySessionExpired } from '@/lib/api-client'
import { LIMITS } from '@/lib/constants'
import type { ApiErrorBody, UploadFileResult, UploadResult, UploadStarted } from '@/lib/contracts'

/**
 * Browser side of file uploads. Files up to LIMITS.uploadPartBytes go up in one request; larger ones
 * in parts (serverless hosts cap request bodies, Vercel at 4.5 MB), each part retried on its own.
 * XMLHttpRequest because fetch cannot report upload progress.
 */

interface Reply {
  /** 0 when the request did not get through (network error). */
  status: number
  body: unknown
}

type Progress = (fraction: number) => void

export interface UploadOptions {
  /** Pause before a part is sent again, times the attempt number (default 1 s). */
  retryDelayMs?: number
}

/** Tries per part before the upload is given up. Sending a part again is safe. */
const PART_ATTEMPTS = 3

function send(method: string, url: string, body: XMLHttpRequestBodyInit | null, onProgress?: Progress): Promise<Reply> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url)
    xhr.withCredentials = true
    const workspace = getActiveWorkspaceId()
    if (workspace) xhr.setRequestHeader(WORKSPACE_HEADER, workspace)
    if (typeof body === 'string') xhr.setRequestHeader('Content-Type', 'application/json')
    else if (body instanceof Blob) xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total)
      }
    }
    xhr.onerror = () => resolve({ status: 0, body: null })
    xhr.onload = () => {
      if (xhr.status === 401) notifySessionExpired()
      let parsed: unknown = null
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        // not JSON (e.g. a proxy's error page)
      }
      resolve({ status: xhr.status, body: parsed })
    }
    xhr.send(body)
  })
}

function failed(file: File, reply: Reply): UploadFileResult {
  const message = (reply.body as Partial<ApiErrorBody> | null)?.error?.message
  const fallback = reply.status === 0 ? 'The upload was interrupted. Check your connection and try again.' : reply.status === 413 ? 'The file is too large.' : 'Upload failed.'
  return { filename: file.name, status: 'error', error: message ?? fallback }
}

/** The per-file result of an upload response, or the error it carries. */
function outcome(file: File, reply: Reply): UploadFileResult {
  return (reply.body as Partial<UploadResult> | null)?.results?.[0] ?? failed(file, reply)
}

async function uploadWhole(file: File, collectionId: string, onProgress: Progress): Promise<UploadFileResult> {
  const form = new FormData()
  form.set('collectionId', collectionId)
  form.append('files', file)
  return outcome(file, await send('POST', '/api/learn/upload', form, onProgress))
}

/** Retries after network errors, rate limits and server errors, with a growing pause. */
async function sendPart(url: string, part: Blob, onProgress: Progress, retryDelayMs: number): Promise<Reply> {
  let reply: Reply = { status: 0, body: null }
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    reply = await send('PUT', url, part, onProgress)
    const retryable = reply.status === 0 || reply.status === 429 || reply.status >= 500
    if (!retryable || attempt === PART_ATTEMPTS) break
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt))
  }
  return reply
}

async function uploadInParts(file: File, collectionId: string, onProgress: Progress, retryDelayMs: number): Promise<UploadFileResult> {
  const started = await send('POST', '/api/learn/uploads', JSON.stringify({ collectionId, fileName: file.name, byteSize: file.size }))
  if (started.status !== 201) return failed(file, started)
  const { uploadId, partBytes, parts } = started.body as UploadStarted
  const base = `/api/learn/uploads/${encodeURIComponent(uploadId)}`
  for (let index = 0; index < parts; index++) {
    const offset = index * partBytes
    const part = file.slice(offset, Math.min(file.size, offset + partBytes))
    const reply = await sendPart(`${base}/parts/${index}`, part, (fraction) => onProgress((offset + fraction * part.size) / file.size), retryDelayMs)
    if (reply.status !== 200) {
      void send('DELETE', base, null) // discard the parts already stored
      return failed(file, reply)
    }
  }
  return outcome(file, await send('POST', `${base}/complete`, null))
}

/** Uploads one file into a notebook; resolves with its result (never rejects). */
export function uploadFile(file: File, collectionId: string, onProgress: Progress, options: UploadOptions = {}): Promise<UploadFileResult> {
  if (file.size <= LIMITS.uploadPartBytes) return uploadWhole(file, collectionId, onProgress)
  return uploadInParts(file, collectionId, onProgress, options.retryDelayMs ?? 1_000)
}
