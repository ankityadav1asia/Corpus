/**
 * Identifies an image by its bytes (never by the MIME type a model or client claims) and reads its
 * dimensions from the header. Only PNG, JPEG and WebP are accepted.
 */

export interface ImageInfo {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number | null
  height: number | null
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]!
    // Start-of-frame markers carry the dimensions (C4 = DHT, C8 = JPG extension, CC = DAC are not SOF).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) }
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    offset += 2 + u16be(bytes, offset + 2)
  }
  return null
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X' && bytes.length >= 30) return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
  if (chunk === 'VP8 ' && bytes.length >= 30) return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 24 && startsWith(bytes, PNG_SIGNATURE) && ascii(bytes, 12, 4) === 'IHDR') {
    return { mimeType: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes)
    return { mimeType: 'image/jpeg', width: size?.width ?? null, height: size?.height ?? null }
  }
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const size = webpSize(bytes)
    return { mimeType: 'image/webp', width: size?.width ?? null, height: size?.height ?? null }
  }
  return null
}
