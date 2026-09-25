import { AUDIO_FILE_EXTENSIONS, IMAGE_FILE_EXTENSIONS, VIDEO_FILE_EXTENSIONS } from '@/lib/constants'
import type { MediaKind } from '@/lib/contracts'

/**
 * Media type detection by content (magic bytes), checked against the extension. The browser's MIME
 * type is never trusted: a renamed file is rejected instead of being sent to a model as something else.
 */

export interface DetectedMedia {
  kind: Exclude<MediaKind, 'scan'>
  mimeType: string
}

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length))
const startsWith = (bytes: Uint8Array, signature: readonly number[]) => signature.every((byte, i) => bytes[i] === byte)

const isPng = (b: Uint8Array) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const isJpeg = (b: Uint8Array) => startsWith(b, [0xff, 0xd8, 0xff])
const isRiff = (b: Uint8Array, form: string) => b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === form
const isMp3 = (b: Uint8Array) => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0)
const isAdts = (b: Uint8Array) => b[0] === 0xff && (b[1]! & 0xf6) === 0xf0
const isIsoMedia = (b: Uint8Array) => b.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(ascii(b, 4, 4))
const isMatroska = (b: Uint8Array) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])

const CHECKS: Record<string, { kind: DetectedMedia['kind']; mimeType: string; test: (bytes: Uint8Array) => boolean }> = {
  '.png': { kind: 'image', mimeType: 'image/png', test: isPng },
  '.jpg': { kind: 'image', mimeType: 'image/jpeg', test: isJpeg },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg', test: isJpeg },
  '.webp': { kind: 'image', mimeType: 'image/webp', test: (b) => isRiff(b, 'WEBP') },
  '.mp3': { kind: 'audio', mimeType: 'audio/mpeg', test: isMp3 },
  '.wav': { kind: 'audio', mimeType: 'audio/wav', test: (b) => isRiff(b, 'WAVE') },
  '.m4a': { kind: 'audio', mimeType: 'audio/mp4', test: isIsoMedia },
  '.aac': { kind: 'audio', mimeType: 'audio/aac', test: isAdts },
  '.ogg': { kind: 'audio', mimeType: 'audio/ogg', test: (b) => ascii(b, 0, 4) === 'OggS' },
  '.flac': { kind: 'audio', mimeType: 'audio/flac', test: (b) => ascii(b, 0, 4) === 'fLaC' },
  '.mp4': { kind: 'video', mimeType: 'video/mp4', test: isIsoMedia },
  '.mov': { kind: 'video', mimeType: 'video/quicktime', test: isIsoMedia },
  '.webm': { kind: 'video', mimeType: 'video/webm', test: isMatroska },
}

export const MEDIA_EXTENSIONS: readonly string[] = [...IMAGE_FILE_EXTENSIONS, ...AUDIO_FILE_EXTENSIONS, ...VIDEO_FILE_EXTENSIONS]

export function isMediaExtension(extension: string): boolean {
  return MEDIA_EXTENSIONS.includes(extension)
}

/** null when the content does not match the extension. */
export function detectMedia(bytes: Uint8Array, extension: string): DetectedMedia | null {
  const check = CHECKS[extension]
  if (!check || bytes.length < 4 || !check.test(bytes)) return null
  return { kind: check.kind, mimeType: check.mimeType }
}
