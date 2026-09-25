import { LIMITS } from '@/lib/constants'
import { imageCreateSchema, type ImageSummary } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { collectionAccess, requireWorkspacePermission } from '@/server/auth/access'
import { readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

/** Generated images of the workspace, newest first (metadata only; pixels come from /file). */
export const GET = workspaceRoute(async ({ access }) => {
  const images = await getServices().repos.images.list(access.workspaceId)
  // The gallery polls while pictures are drawn: keep the queue moving (retries included).
  if (images.some((image) => image.status === 'queued' || image.status === 'running')) processJobsAfterResponse()
  return json<{ images: ImageSummary[] }>({ images })
})

/**
 * Queues an image grounded in the knowledge base (any member — it only draws on content they can
 * already read). Returns 202 immediately; the picture is produced in the background.
 */
export const POST = workspaceRoute(async ({ req, access }) => {
  requireWorkspacePermission(access, 'images.create')
  const input = await readJson(req, imageCreateSchema, 16 * 1024)
  const services = getServices()
  services.ai() // fail fast with 503 when AI is not configured
  if (!services.images()) throw Errors.notConfigured('Image generation is not configured on this server.')
  await enforceRateLimit(services.repos, `images:user:${access.userId}`, RATE_LIMITS.images)

  if (input.collectionId) await collectionAccess(services.repos, access, input.collectionId)
  if (input.documentIds.length > 0) {
    const found = await services.repos.documents.resolveReportDocuments(access.workspaceId, { collectionIds: [], documentIds: input.documentIds }, input.documentIds.length)
    if (found.length !== new Set(input.documentIds).size) throw Errors.badRequest('Some selected documents do not exist or are not indexed yet.')
  }
  if ((await services.repos.images.count(access.workspaceId)) >= LIMITS.imagesPerWorkspace) {
    throw Errors.conflict(`A workspace can keep at most ${LIMITS.imagesPerWorkspace} images. Delete some to make room.`)
  }

  const image = await services.repos.images.create({
    workspaceId: access.workspaceId,
    createdBy: access.userId,
    collectionId: input.documentIds.length > 0 ? null : (input.collectionId ?? null),
    documentIds: input.documentIds,
    prompt: input.prompt,
    style: input.style,
    aspectRatio: input.aspectRatio,
  })
  await services.repos.jobs.enqueue('generate_image', { imageId: image.id }, { maxAttempts: JOB_ATTEMPTS.generate_image })
  await recordAudit(services.repos, access, 'image.created', { type: 'image', id: image.id }, { style: image.style })
  processJobsAfterResponse()
  return json<{ image: ImageSummary }>({ image }, { status: 202 })
})
