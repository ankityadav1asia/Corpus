import { idSchema } from '@/lib/contracts'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { authedRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

function fileName(title: string | null, mimeType: string) {
  const base =
    (title ?? 'image')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'image'
  return `${base}.${EXTENSIONS[mimeType] ?? 'png'}`
}

/**
 * The image bytes, for <img src> (which cannot send the workspace header): the image's own
 * workspace is looked up and the caller must be a member of it (404 otherwise).
 * `?download=1` serves it as an attachment.
 */
export const GET = authedRoute<{ id: string }>(async ({ req, params, user }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  const file = await repos.images.file(id)
  if (!file || !(await repos.workspaces.membership(file.workspaceId, user.id))) throw Errors.notFound('Image')
  const download = req.nextUrl.searchParams.get('download') === '1'
  return new Response(new Uint8Array(file.data), {
    headers: {
      'Content-Type': file.mimeType,
      'Content-Length': String(file.data.byteLength),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${fileName(file.title, file.mimeType)}"`,
      // Image ids are never reused and images never change; keep them in the private browser cache.
      'Cache-Control': 'private, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  })
})
