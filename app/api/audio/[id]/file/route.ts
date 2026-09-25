import { idSchema } from '@/lib/contracts'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { parseRange } from '@/server/http/range'
import { authedRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

function fileName(title: string) {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'audio-overview'
  return `${base}.mp3`
}

/**
 * The recording, for <audio src> (which cannot send the workspace header): the overview's own
 * workspace is looked up and the caller must be a member (404 otherwise). Supports Range requests so
 * players can seek. `?download=1` serves it as an attachment.
 */
export const GET = authedRoute<{ id: string }>(async ({ req, params, user }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  const file = await repos.audio.file(id)
  if (!file || !(await repos.workspaces.membership(file.workspaceId, user.id))) throw Errors.notFound('Audio overview')
  const download = req.nextUrl.searchParams.get('download') === '1'
  const size = file.data.byteLength
  const headers: Record<string, string> = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${fileName(file.title)}"`,
    // Recordings never change once completed.
    'Cache-Control': 'private, max-age=86400, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  }
  const rangeHeader = req.headers.get('range')
  const range = parseRange(rangeHeader, size)
  if (rangeHeader && !range) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
  if (range) {
    const body = new Uint8Array(file.data.slice(range.start, range.end + 1))
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Length': String(body.byteLength), 'Content-Range': `bytes ${range.start}-${range.end}/${size}` },
    })
  }
  return new Response(new Uint8Array(file.data), { headers: { ...headers, 'Content-Length': String(size) } })
})
