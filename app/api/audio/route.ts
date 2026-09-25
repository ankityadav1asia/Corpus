import { STUDIO_LIMITS } from '@/lib/constants'
import { audioCreateSchema, type AudioSummary } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireWorkspacePermission } from '@/server/auth/access'
import { readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'
import { checkSelection, selectionTitle } from '@/server/studio/selection'

/** Audio overviews of the workspace, newest first. */
export const GET = workspaceRoute(async ({ access }) => {
  const overviews = await getServices().repos.audio.list(access.workspaceId)
  // Polled while recordings are made: keep the queue moving (retries and continuations included).
  if (overviews.some((item) => item.status === 'queued' || item.status === 'running')) processJobsAfterResponse()
  return json<{ overviews: AudioSummary[] }>({ overviews })
})

/**
 * Queues a two-host audio overview of the selected notebooks / documents (any member — it only draws
 * on content they can read). Returns 202; the script is written and recorded in the background.
 */
export const POST = workspaceRoute(async ({ req, access }) => {
  requireWorkspacePermission(access, 'audio.create')
  const input = await readJson(req, audioCreateSchema, 16 * 1024)
  const services = getServices()
  services.ai() // 503 when AI is not configured
  if (!services.speech()) throw Errors.notConfigured('Audio overviews need a text-to-speech model, and none is configured on this server.')
  await enforceRateLimit(services.repos, `audio:user:${access.userId}`, RATE_LIMITS.audio)
  await checkSelection(services.repos, access, input)
  if ((await services.repos.audio.count(access.workspaceId)) >= STUDIO_LIMITS.audioPerWorkspace) {
    throw Errors.conflict(`A workspace can keep at most ${STUDIO_LIMITS.audioPerWorkspace} audio overviews. Delete some to make room.`)
  }
  const overview = await services.repos.audio.create({
    workspaceId: access.workspaceId,
    createdBy: access.userId,
    title: await selectionTitle(services.repos, access, 'Audio overview', input.collectionIds),
    format: input.format,
    length: input.length,
    language: input.language,
    focus: input.focus || null,
    collectionIds: input.collectionIds,
    documentIds: input.documentIds,
  })
  await services.repos.jobs.enqueue('generate_audio', { audioId: overview.id }, { maxAttempts: JOB_ATTEMPTS.generate_audio })
  await recordAudit(services.repos, access, 'audio.created', { type: 'audio', id: overview.id }, { format: overview.format, length: overview.length })
  processJobsAfterResponse()
  return json<{ overview: AudioSummary }>({ overview }, { status: 202 })
})
