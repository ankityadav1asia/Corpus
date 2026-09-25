/**
 * Minimal PCM helpers for speech: decode WAV / raw L16 into 16-bit mono samples, resample, and
 * concatenate. Enough for TTS output; not a general audio library.
 */

export interface Pcm {
  pcm: Int16Array
  sampleRate: number
}

/** Raw little-endian 16-bit PCM (Gemini returns `audio/L16;codec=pcm;rate=24000`). */
export function pcmFromL16(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(Math.floor(bytes.length / 2))
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true)
  return samples
}

/** `audio/L16;codec=pcm;rate=24000` → 24000 (default 24 kHz). */
export function sampleRateFromMime(mimeType: string | undefined, fallback = 24_000): number {
  const match = /rate=(\d+)/i.exec(mimeType ?? '')
  const rate = match ? Number.parseInt(match[1]!, 10) : NaN
  return Number.isFinite(rate) && rate >= 8_000 && rate <= 96_000 ? rate : fallback
}

const ascii = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)

interface WavLayout {
  /** 1 = integer PCM, 3 = IEEE float. */
  format: number
  channels: number
  sampleRate: number
  bits: number
  data: { start: number; length: number } | null
}

/** Walks the RIFF chunks for the format ("fmt ") and the samples ("data"). */
function readLayout(bytes: Uint8Array, view: DataView): WavLayout {
  const layout: WavLayout = { format: 0, channels: 1, sampleRate: 0, bits: 16, data: null }
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset)
    let size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (id === 'data') {
      // Streaming servers sometimes write 0 or 0xFFFFFFFF as the data size: read to the end then.
      if (size === 0 || size === 0xffffffff || start + size > bytes.length) size = bytes.length - start
      layout.data = { start, length: size }
      return layout
    }
    if (id === 'fmt ') {
      layout.format = view.getUint16(start, true)
      layout.channels = view.getUint16(start + 2, true)
      layout.sampleRate = view.getUint32(start + 4, true)
      layout.bits = view.getUint16(start + 14, true)
      if (layout.format === 0xfffe && size >= 26) layout.format = view.getUint16(start + 24, true) // WAVE_FORMAT_EXTENSIBLE
    }
    offset = start + size + (size % 2)
  }
  return layout
}

/** One sample as a number in [-1, 1]. */
function sampleAt(view: DataView, at: number, format: number, bits: number): number {
  if (format === 3) return bits === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true)
  switch (bits) {
    case 8:
      return (view.getUint8(at) - 128) / 128
    case 16:
      return view.getInt16(at, true) / 32768
    case 24:
      return (((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)) << 8) >> 8) / 8388608
    default:
      return view.getInt32(at, true) / 2147483648
  }
}

/** Decodes PCM WAV (8/16/24/32-bit integer or 32-bit float, any channel count) to 16-bit mono. */
export function decodeWav(bytes: Uint8Array): Pcm {
  if (bytes.length < 44 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') throw new Error('Not a WAV file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const { format, channels, sampleRate, bits, data } = readLayout(bytes, view)
  if (!data || !sampleRate || channels < 1) throw new Error('WAV file has no audio data')
  if (format !== 1 && format !== 3) throw new Error(`Unsupported WAV encoding (${format})`)
  const bytesPerSample = bits / 8
  const frames = Math.floor(data.length / (bytesPerSample * channels))
  const pcm = new Int16Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) sum += sampleAt(view, data.start + (frame * channels + channel) * bytesPerSample, format, bits)
    pcm[frame] = clamp16((sum / channels) * 32768)
  }
  return { pcm, sampleRate }
}

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)))
}

/** Linear-interpolation resampling (adequate for speech). */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || pcm.length === 0) return pcm
  const length = Math.max(1, Math.round((pcm.length * to) / from))
  const out = new Int16Array(length)
  const ratio = from / to
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, pcm.length - 1)
    const fraction = position - left
    out[i] = clamp16(pcm[Math.min(left, pcm.length - 1)]! * (1 - fraction) + pcm[right]! * fraction)
  }
  return out
}

export function concatPcm(parts: readonly Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function silence(seconds: number, sampleRate: number): Int16Array {
  return new Int16Array(Math.round(seconds * sampleRate))
}

/** 16-bit mono PCM as a WAV file. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(bytes.buffer)
  const write = (at: number, text: string) => [...text].forEach((ch, i) => (bytes[at + i] = ch.charCodeAt(0)))
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i]!, true)
  return bytes
}
