import { idSchema } from '@/lib/contracts'
import { rangedFileResponse } from '@/server/http/binary'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
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
  const headers: Record<string, string> = {
    'Content-Type': 'audio/mpeg',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${fileName(file.title)}"`,
    // Recordings never change once completed.
    'Cache-Control': 'private, max-age=86400, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  }
  return rangedFileResponse(file.data, headers, req.headers.get('range'))
})
