import { parseRange } from '@/server/http/range'

/** Size of the pieces a stored file is streamed in. */
const PIECE_BYTES = 256 * 1024

function streamed(bytes: Uint8Array, status: number, headers: Record<string, string>): Response {
  let offset = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close()
      const end = Math.min(offset + PIECE_BYTES, bytes.byteLength)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
  })
  return new Response(body, { status, headers })
}

/**
 * A stored file (original PDF, recording, image) as a streamed response. Serverless hosts cap
 * buffered response bodies (Vercel at 4.5 MB) but not streamed ones, so files of any size can be served.
 */
export function fileResponse(bytes: Uint8Array, headers: Record<string, string>): Response {
  return streamed(bytes, 200, { ...headers, 'Content-Length': String(bytes.byteLength) })
}

/**
 * Like `fileResponse`, with single byte ranges so media players can seek: 206 with the requested
 * bytes, 416 when the range cannot be satisfied, the whole file without a Range header.
 */
export function rangedFileResponse(bytes: Uint8Array, headers: Record<string, string>, rangeHeader: string | null): Response {
  const size = bytes.byteLength
  const base = { ...headers, 'Accept-Ranges': 'bytes' }
  if (!rangeHeader) return fileResponse(bytes, base)
  const range = parseRange(rangeHeader, size)
  if (!range) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
  const part = bytes.subarray(range.start, range.end + 1)
  return streamed(part, 206, { ...base, 'Content-Length': String(part.byteLength), 'Content-Range': `bytes ${range.start}-${range.end}/${size}` })
}
