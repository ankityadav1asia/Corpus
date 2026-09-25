import type { Transcriber, VisionModel } from '@/server/ai/media'
import { isAppError } from '@/server/http/errors'
import { planText } from '@/server/ingestion/ingest-service'
import { PermanentJobError } from '@/server/jobs/errors'
import { log } from '@/server/logger'
import type { OcrEngine } from '@/server/media/ocr'
import type { Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import type { PendingMedia } from '@/server/repositories/media'

/**
 * Background reading of media sources before indexing:
 *   image — the vision model transcribes and describes it (OCR when no vision model, or as a fallback),
 *   scan  — scanned PDF pages are rendered and read with OCR one by one; each page is stored as it is
 *           read, so a long scan continues across job runs,
 *   audio / video — transcribed with timestamps.
 * The text is then handed to the normal indexing job.
 */

export interface MediaDeps {
  repos: Pick<Repositories, 'documents' | 'media' | 'jobs'>
  vision: () => VisionModel | null
  transcriber: () => Transcriber | null
  ocr: () => OcrEngine | null
  /** Renders one PDF page as PNG (injected so tests need no PDF engine). */
  renderPage?: (pdf: Uint8Array, page: number) => Promise<Uint8Array>
}

/** A4 at ~240 dpi: sharp enough for OCR, small enough to be quick. */
const RENDER_WIDTH = 2000

export async function renderPdfPage(pdf: Uint8Array, page: number): Promise<Uint8Array> {
  const { PDFParse } = await import('pdf-parse')
  // pdf.js transfers (detaches) the buffer it is given; later pages are rendered from the same bytes.
  const parser = new PDFParse({ data: pdf.slice() })
  try {
    const result = await parser.getScreenshot({ partial: [page], desiredWidth: RENDER_WIDTH, imageDataUrl: false, imageBuffer: true })
    const shot = result.pages[0]
    if (!shot?.data?.length) throw new Error(`Page ${page} could not be rendered`)
    return shot.data
  } finally {
    await parser.destroy()
  }
}

async function readImage(deps: MediaDeps, media: PendingMedia, data: Uint8Array): Promise<string> {
  const vision = deps.vision()
  const ocr = deps.ocr()
  if (!vision && !ocr) throw new PermanentJobError('Reading images needs OCR or a vision model, and both are turned off on this server.')
  try {
    if (vision) {
      try {
        const text = await vision.readImage({ data, mimeType: media.mimeType, mode: 'describe' })
        if (text.trim()) return text
      } catch (error) {
        // Keep going with OCR when the vision model is unavailable (quota, outage).
        if (!ocr) throw error
        log.warn('Vision model failed; falling back to OCR', { documentId: media.id, error: String(error) })
      }
    }
    if (!ocr) return ''
    const result = await ocr.recognize({ data, mimeType: media.mimeType })
    return result.text ? `Text in the image:\n${result.text}` : ''
  } finally {
    await ocr?.close()
  }
}

async function readScan(deps: MediaDeps, media: PendingMedia, deadline: number): Promise<string | 'more'> {
  const total = media.pageCount ?? 0
  const stored = await deps.repos.media.pageTexts(media.id)
  const done = new Map(stored.map((page) => [page.page, page.text]))
  const missing = Array.from({ length: total }, (_, index) => index + 1).filter((page) => !done.has(page))
  // Progress counts only the pages that need OCR, including those read by earlier runs.
  const ocrTotal = total - stored.filter((page) => page.method === 'text').length
  let ocrDone = stored.filter((page) => page.method === 'ocr').length
  if (missing.length > 0) {
    const ocr = deps.ocr()
    if (!ocr) throw new PermanentJobError('This PDF is scanned (it has no text layer), and OCR is turned off on this server.')
    const pdf = await deps.repos.media.bytes(media.id)
    const render = deps.renderPage ?? renderPdfPage
    try {
      for (const page of missing) {
        if (Date.now() > deadline) return 'more'
        await deps.repos.documents.setProgress(media.id, `Reading scanned pages with OCR (${ocrDone + 1}/${ocrTotal})`)
        const image = await render(pdf, page)
        const { text } = await ocr.recognize({ data: image, mimeType: 'image/png' })
        await deps.repos.media.savePage(media.id, page, text, 'ocr')
        done.set(page, text)
        ocrDone++
      }
    } finally {
      await ocr.close()
    }
  }
  return [...done.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .filter((text) => text.trim())
    .join('\n\n')
}

async function transcribe(deps: MediaDeps, media: PendingMedia, data: Uint8Array): Promise<string> {
  const transcriber = deps.transcriber()
  if (!transcriber) throw new PermanentJobError(`Transcribing ${media.kind} is not configured on this server (TRANSCRIPTION_PROVIDER).`)
  await deps.repos.documents.setProgress(media.id, media.kind === 'video' ? 'Transcribing the video…' : 'Transcribing the audio…')
  return transcriber.transcribe({ data, mimeType: media.mimeType, fileName: media.fileName, kind: media.kind === 'video' ? 'video' : 'audio' })
}

/** Reads one queued media document; 'more' when the time budget ran out (a scan continues in a new run). */
export async function readQueuedMedia(deps: MediaDeps, documentId: string, deadline: number): Promise<'done' | 'more' | 'missing'> {
  const media = await deps.repos.media.pending(documentId)
  if (!media) return 'missing'

  let text: string
  if (media.kind === 'scan') {
    const result = await readScan(deps, media, deadline)
    if (result === 'more') return 'more'
    text = result
  } else {
    await deps.repos.documents.setProgress(media.id, media.kind === 'image' ? 'Reading the image…' : 'Preparing the file…')
    const data = await deps.repos.media.bytes(media.id)
    text = media.kind === 'image' ? await readImage(deps, media, data) : await transcribe(deps, media, data)
  }

  let planned: { text: string; pieces: string[] }
  try {
    planned = planText(text)
  } catch (error) {
    if (!isAppError(error)) throw error
    const reason = error.status === 413 ? error.message : `No readable ${media.kind === 'audio' || media.kind === 'video' ? 'speech' : 'text'} was found in “${media.fileName}”.`
    throw new PermanentJobError(reason)
  }
  await deps.repos.media.stageText(media.id, planned.text, planned.pieces.length, media.replaceExisting)
  await deps.repos.jobs.enqueue('ingest_document', { documentId: media.id }, { maxAttempts: JOB_ATTEMPTS.ingest_document })
  log.info('Media read', { documentId: media.id, kind: media.kind, chars: planned.text.length })
  return 'done'
}
