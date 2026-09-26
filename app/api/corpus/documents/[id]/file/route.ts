import { idSchema } from '@/lib/contracts'
import { requireCollectionPermission } from '@/server/auth/access'
import { fileResponse } from '@/server/http/binary'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/** The original uploaded file (PDFs), for the in-app viewer (any member who can see the notebook). */
export const GET = workspaceRoute<{ id: string }>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  const document = await repos.documents.get(access.workspaceId, id)
  if (!document) throw Errors.notFound('Document')
  await requireCollectionPermission(repos, access, document.collectionId, 'collection.view')
  const info = await repos.media.fileInfo(access.workspaceId, id)
  if (!info) throw Errors.notFound('Original file')
  const bytes = await repos.media.fileBytes(access.workspaceId, id)
  return fileResponse(bytes, {
    // Only PDFs are kept; served as a download-safe binary the viewer reads with pdf.js.
    'Content-Type': info.mimeType === 'application/pdf' ? 'application/pdf' : 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(info.fileName).replace(/%20/g, ' ')}"`,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  })
})
