import { YoutubeTranscript } from 'youtube-transcript'

import { ACCEPTED_FILE_EXTENSIONS, LIMITS } from '@/lib/constants'
import type { MediaKind } from '@/lib/contracts'
import { Errors } from '@/server/http/errors'
import { detectMedia, isMediaExtension } from '@/server/media/detect'
import { decodeHtmlEntities, delimitedToText, htmlToDocument, normalizeExtractedText, truncateTitle } from '@/server/ingestion/text'
import { log } from '@/server/logger'
import { parseFetchableUrl, safeFetchText, type FetchedPage } from '@/server/security/ssrf'

export interface ExtractedDocument {
  title: string
  text: string
  /** Canonical source identifier (file name, normalised URL, video URL). */
  source: string
}

type AcceptedExtension = (typeof ACCEPTED_FILE_EXTENSIONS)[number]

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

function isAccepted(extension: string): extension is AcceptedExtension {
  return (ACCEPTED_FILE_EXTENSIONS as readonly string[]).includes(extension)
}

const utf8 = new TextDecoder('utf-8')
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-

/** A page with less text than this in its text layer is treated as scanned (it gets OCR). */
const SCANNED_PAGE_CHARS = 25

export interface PdfPages {
  total: number
  pages: Array<{ page: number; text: string }>
}

async function extractPdfPages(bytes: Uint8Array): Promise<PdfPages> {
  const { PDFParse } = await import('pdf-parse')
  // pdf.js transfers (detaches) the buffer it is given: hand it a copy, the caller still needs the bytes.
  const parser = new PDFParse({ data: bytes.slice() })
  try {
    const result = await parser.getText({ pageJoiner: '' })
    return { total: result.total, pages: result.pages.map((page) => ({ page: page.num, text: normalizeExtractedText(page.text) })) }
  } finally {
    await parser.destroy()
  }
}

/** Pages whose text layer is (almost) empty — those are read with OCR. */
export function scannedPages(pdf: PdfPages): number[] {
  const withText = new Set(pdf.pages.filter((page) => page.text.length >= SCANNED_PAGE_CHARS).map((page) => page.page))
  return Array.from({ length: pdf.total }, (_, index) => index + 1).filter((page) => !withText.has(page))
}

/** What an upload turned out to be: text to index now, or media to read first (OCR / transcription). */
export type UploadContent =
  | { type: 'text'; document: ExtractedDocument }
  | {
      type: 'media'
      title: string
      source: string
      kind: MediaKind
      mimeType: string
      data: Uint8Array
      /** Scanned PDFs: page count and the pages that already have text. */
      pageCount: number | null
      pages: Array<{ page: number; text: string }>
    }

function checkFile(name: string, size: number): string {
  if (size === 0) throw Errors.unprocessable(`"${name}" is empty.`)
  if (size > LIMITS.fileBytes) throw Errors.payloadTooLarge(`"${name}" is larger than ${LIMITS.fileBytes / (1024 * 1024)} MB.`)
  const extension = fileExtension(name)
  if (!isAccepted(extension)) throw Errors.unsupportedMediaType(`"${name}" is not a supported file type.`)
  return extension
}

/**
 * Type is decided by extension *and* verified by content (magic bytes), never by the client MIME type.
 * Text formats are extracted immediately; images, audio, video and scanned PDFs are returned as media
 * for a background job to read.
 */
export async function readUpload(file: File): Promise<UploadContent> {
  const name = file.name || 'upload'
  const extension = checkFile(name, file.size)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const title = truncateTitle(name)
  const source = truncateTitle(name, 500)

  if (isMediaExtension(extension)) {
    const media = detectMedia(bytes, extension)
    if (!media) throw Errors.unprocessable(`"${name}" does not look like a valid ${extension.slice(1).toUpperCase()} file.`)
    return { type: 'media', title, source, kind: media.kind, mimeType: media.mimeType, data: bytes, pageCount: null, pages: [] }
  }

  if (extension === '.pdf') {
    if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) throw Errors.unprocessable(`"${name}" is not a valid PDF.`)
    let pdf: PdfPages
    try {
      pdf = await extractPdfPages(bytes)
    } catch (error) {
      log.warn('PDF extraction failed', { file: name, error: String(error) })
      throw Errors.unprocessable(`Could not read "${name}". The PDF may be damaged or password-protected.`)
    }
    const scanned = scannedPages(pdf)
    if (scanned.length === 0) {
      const text = normalizeExtractedText(pdf.pages.map((page) => page.text).join('\n\n'))
      if (!text) throw Errors.unprocessable(`No readable text found in "${name}".`)
      return { type: 'text', document: { title, text, source } }
    }
    if (scanned.length > LIMITS.ocrPages) {
      throw Errors.payloadTooLarge(`"${name}" has ${scanned.length} scanned pages; at most ${LIMITS.ocrPages} can be read with OCR.`)
    }
    const pages = pdf.pages.filter((page) => page.text.length >= SCANNED_PAGE_CHARS)
    return { type: 'media', title, source, kind: 'scan', mimeType: 'application/pdf', data: bytes, pageCount: pdf.total, pages }
  }

  return { type: 'text', document: await extractTextFile(name, extension, bytes) }
}

async function extractTextFile(name: string, extension: string, bytes: Uint8Array): Promise<ExtractedDocument> {
  let text: string
  switch (extension) {
    case '.csv':
      text = delimitedToText(utf8.decode(bytes), ',')
      break
    case '.tsv':
      text = delimitedToText(utf8.decode(bytes), '\t')
      break
    case '.json':
      text = utf8.decode(bytes)
      try {
        text = JSON.stringify(JSON.parse(text.replace(/^﻿/, '')), null, 2)
      } catch {
        // keep raw text: still searchable
      }
      break
    case '.html':
    case '.htm':
      text = htmlToDocument(utf8.decode(bytes), name).text
      break
    default:
      text = utf8.decode(bytes).replace(/^﻿/, '')
  }

  text = normalizeExtractedText(text)
  if (!text) throw Errors.unprocessable(`No readable text found in "${name}".`)
  return { title: truncateTitle(name), text, source: truncateTitle(name, 500) }
}

export async function extractWebPage(rawUrl: string, fetchPage: (url: string) => Promise<FetchedPage> = (url) => safeFetchText(url)): Promise<ExtractedDocument> {
  const canonical = parseFetchableUrl(rawUrl)
  canonical.hash = ''
  const page = await fetchPage(canonical.toString())
  const mime = page.contentType.split(';')[0]!.trim()
  if (mime === 'text/plain' || mime === 'text/markdown') {
    const lastSegment = new URL(page.url).pathname.split('/').filter(Boolean).pop() ?? ''
    let title = lastSegment
    try {
      title = decodeURIComponent(lastSegment)
    } catch {
      // keep the raw segment
    }
    return { title: truncateTitle(title || canonical.hostname), text: normalizeExtractedText(page.body), source: canonical.toString() }
  }
  const document = htmlToDocument(page.body, canonical.hostname)
  if (document.text.length < 50) throw Errors.unprocessable('Could not find enough readable text on that page.')
  return { title: document.title, text: document.text, source: canonical.toString() }
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

export function parseYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim()
  if (VIDEO_ID.test(trimmed)) return trimmed
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.replace(/^(www|m|music)\./, '')
  let candidate: string | null = null
  if (host === 'youtu.be') {
    candidate = url.pathname.split('/')[1] ?? null
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    candidate = url.pathname === '/watch' ? url.searchParams.get('v') : (/^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null)
  }
  return candidate && VIDEO_ID.test(candidate) ? candidate : null
}

export async function extractYouTubeTranscript(input: string): Promise<ExtractedDocument> {
  const videoId = parseYouTubeVideoId(input)
  if (!videoId) throw Errors.badRequest('Enter a YouTube video link (youtube.com/watch?v=…, youtu.be/…, or /shorts/…).')

  let items: Array<{ text: string }>
  try {
    items = await YoutubeTranscript.fetchTranscript(videoId)
  } catch (error) {
    log.warn('YouTube transcript fetch failed', { videoId, error: String(error) })
    throw Errors.unprocessable('Could not fetch captions for this video. It may have captions disabled, or YouTube refused the request.')
  }
  const text = normalizeExtractedText(items.map((item) => decodeHtmlEntities(item.text)).join(' '))
  if (!text) throw Errors.unprocessable('This video has no caption text.')
  const url = `https://www.youtube.com/watch?v=${videoId}`
  return { title: `YouTube video ${videoId}`, text, source: url }
}
