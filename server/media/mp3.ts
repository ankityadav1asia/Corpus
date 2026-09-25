/**
 * MP3 encoding of speech (LAME via @breezystack/lamejs, pure JavaScript, server-side only).
 * 64 kbit/s mono keeps a 10-minute overview around 5 MB instead of ~30 MB of WAV.
 */

const KBPS = 64
const FRAME = 1152
/** Sample rates the MP3 format supports. */
const RATES = [8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000]

export function mp3SampleRate(rate: number): number {
  return RATES.reduce((best, candidate) => (Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best), RATES[0]!)
}

export async function encodeMp3(pcm: Int16Array, sampleRate: number): Promise<Uint8Array> {
  const { Mp3Encoder } = await import('@breezystack/lamejs')
  const encoder = new Mp3Encoder(1, sampleRate, KBPS)
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < pcm.length; offset += FRAME) {
    const encoded = encoder.encodeBuffer(pcm.subarray(offset, offset + FRAME))
    if (encoded.length) chunks.push(new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength))
  }
  const tail = encoder.flush()
  if (tail.length) chunks.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.byteLength))
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
