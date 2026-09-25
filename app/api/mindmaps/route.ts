import { STUDIO_LIMITS } from '@/lib/constants'
import { mindMapCreateSchema, type MindMapSummary } from '@/lib/contracts'
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

/** Mind maps of the workspace, newest first. */
export const GET = workspaceRoute(async ({ access }) => {
  const maps = await getServices().repos.mindMaps.list(access.workspaceId)
  if (maps.some((item) => item.status === 'queued' || item.status === 'running')) processJobsAfterResponse()
  return json<{ mindMaps: MindMapSummary[] }>({ mindMaps: maps })
})

/** Queues a mind map of the selected notebooks / documents (any member). Returns 202. */
export const POST = workspaceRoute(async ({ req, access }) => {
  requireWorkspacePermission(access, 'mindmaps.create')
  const input = await readJson(req, mindMapCreateSchema, 16 * 1024)
  const services = getServices()
  services.ai()
  await enforceRateLimit(services.repos, `mindmaps:user:${access.userId}`, RATE_LIMITS.mindmaps)
  await checkSelection(services.repos, access, input)
  if ((await services.repos.mindMaps.count(access.workspaceId)) >= STUDIO_LIMITS.mindMapsPerWorkspace) {
    throw Errors.conflict(`A workspace can keep at most ${STUDIO_LIMITS.mindMapsPerWorkspace} mind maps. Delete some to make room.`)
  }
  const mindMap = await services.repos.mindMaps.create({
    workspaceId: access.workspaceId,
    createdBy: access.userId,
    title: await selectionTitle(services.repos, access, 'Mind map', input.collectionIds),
    focus: input.focus || null,
    collectionIds: input.collectionIds,
    documentIds: input.documentIds,
  })
  await services.repos.jobs.enqueue('generate_mindmap', { mindMapId: mindMap.id }, { maxAttempts: JOB_ATTEMPTS.generate_mindmap })
  await recordAudit(services.repos, access, 'mindmap.created', { type: 'mindmap', id: mindMap.id }, { title: mindMap.title })
  processJobsAfterResponse()
  return json<{ mindMap: MindMapSummary }>({ mindMap }, { status: 202 })
})
