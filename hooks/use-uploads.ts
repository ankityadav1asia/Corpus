'use client'

import { useCallback, useRef, useState } from 'react'

import { WORKSPACE_HEADER, getActiveWorkspaceId, notifySessionExpired } from '@/lib/api-client'
import type { ApiErrorBody, DocumentSummary, UploadResult } from '@/lib/contracts'

export interface UploadItem {
  id: string
  name: string
  size: number
  /** 0–1 while the bytes are sent. */
  progress: number
  status: 'waiting' | 'uploading' | 'queued' | 'error'
  error?: string
  document?: DocumentSummary
}

let counter = 0

/** Sends one file per request (XMLHttpRequest, because fetch cannot report upload progress). */
function send(file: File, collectionId: string, onProgress: (fraction: number) => void): Promise<UploadResult['results'][number]> {
  return new Promise((resolve) => {
    const form = new FormData()
    form.set('collectionId', collectionId)
    form.append('files', file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/learn/upload')
    xhr.withCredentials = true
    const workspace = getActiveWorkspaceId()
    if (workspace) xhr.setRequestHeader(WORKSPACE_HEADER, workspace)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onerror = () => resolve({ filename: file.name, status: 'error', error: 'The upload was interrupted. Check your connection and try again.' })
    xhr.onload = () => {
      if (xhr.status === 401) notifySessionExpired()
      try {
        const body = JSON.parse(xhr.responseText) as Partial<UploadResult & ApiErrorBody>
        const result = body.results?.[0]
        if (result) return resolve(result)
        resolve({ filename: file.name, status: 'error', error: body.error?.message ?? 'Upload failed.' })
      } catch {
        resolve({ filename: file.name, status: 'error', error: xhr.status === 413 ? 'The file is too large.' : 'Upload failed.' })
      }
    }
    xhr.send(form)
  })
}

/** Upload queue: files go up one at a time with live progress; indexing then continues on the server. */
export function useUploads(onQueued: (document: DocumentSummary) => void) {
  const [items, setItems] = useState<UploadItem[]>([])
  const queue = useRef<Array<{ id: string; file: File; collectionId: string }>>([])
  const busy = useRef(false)

  const patch = useCallback((id: string, change: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)))
  }, [])

  const upload = useCallback(
    async (files: File[], collectionId: string) => {
      const entries = files.map((file) => ({ id: `upload-${Date.now()}-${counter++}`, file, collectionId }))
      setItems((current) => [
        ...current.filter((item) => item.status !== 'queued'),
        ...entries.map(({ id, file }) => ({ id, name: file.name, size: file.size, progress: 0, status: 'waiting' as const })),
      ])
      queue.current.push(...entries)
      if (busy.current) return // the running loop picks the new files up
      busy.current = true
      try {
        for (let next = queue.current.shift(); next; next = queue.current.shift()) {
          const { id, file } = next
          patch(id, { status: 'uploading' })
          const result = await send(file, next.collectionId, (progress) => patch(id, { progress }))
          if (result.status === 'queued' && result.document) {
            patch(id, { status: 'queued', progress: 1, document: result.document })
            onQueued(result.document)
          } else {
            patch(id, { status: 'error', error: result.error ?? 'Upload failed.' })
          }
        }
      } finally {
        busy.current = false
      }
    },
    [onQueued, patch],
  )

  const dismiss = useCallback((id: string) => setItems((current) => current.filter((item) => item.id !== id)), [])
  const clear = useCallback(() => setItems((current) => current.filter((item) => item.status === 'uploading' || item.status === 'waiting')), [])

  return { items, upload, dismiss, clear, uploading: items.some((item) => item.status === 'uploading' || item.status === 'waiting') }
}
