import { ACCEPTED_FILE_EXTENSIONS } from '@/lib/constants'

/** File naming shared by connectors that import binary files (Drive, and anything similar later). */

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/html': '.html',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

const accepted = (extension: string) => (ACCEPTED_FILE_EXTENSIONS as readonly string[]).includes(extension)

/** The name to store a downloaded file under: its own extension when supported, else one from its type. */
export function importableFileName(name: string, mimeType: string | null | undefined): string | null {
  if (accepted(extensionOf(name))) return name
  const extension = mimeType ? EXTENSION_BY_MIME[mimeType.split(';')[0]!.trim().toLowerCase()] : undefined
  return extension ? `${name}${extension}` : null
}
