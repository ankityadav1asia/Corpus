import { idSchema, type JobStatus } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireOwnerOrAdmin } from '@/server/auth/access'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import type { Repositories } from '@/server/repositories'
import { getServices } from '@/server/services'

interface OwnedStudioItem {
  title: string | null
  status: JobStatus
  createdBy: string | null
}

interface StudioItemRepository<T extends OwnedStudioItem> {
  get(workspaceId: string, id: string): Promise<T | null>
  delete(workspaceId: string, id: string): Promise<boolean>
}

/**
 * GET and DELETE for one studio item (report, image, audio overview, mind map): the same rules for
 * all of them — any member reads it (reading a running item keeps the job queue moving), and its
 * creator or a workspace admin deletes it.
 */
export function studioItemRoutes<T extends OwnedStudioItem>(config: {
  /** "Audio overview" — for messages. */
  noun: string
  /** Property of the GET response, e.g. "overview". */
  responseKey: string
  /** Audit target type, e.g. "audio" → "audio.deleted". */
  auditType: string
  repository: (repos: Repositories) => StudioItemRepository<T>
}) {
  type Params = { id: string }

  const GET = workspaceRoute<Params>(async ({ params, access }) => {
    const id = parseWith(idSchema, params.id)
    const item = await config.repository(getServices().repos).get(access.workspaceId, id)
    if (!item) throw Errors.notFound(config.noun)
    if (item.status === 'queued' || item.status === 'running') processJobsAfterResponse()
    const { createdBy: _createdBy, ...detail } = item
    return json({ [config.responseKey]: detail })
  })

  const DELETE = workspaceRoute<Params>(async ({ params, access }) => {
    const id = parseWith(idSchema, params.id)
    const { repos } = getServices()
    const repository = config.repository(repos)
    const item = await repository.get(access.workspaceId, id)
    if (!item) throw Errors.notFound(config.noun)
    requireOwnerOrAdmin(access, item.createdBy, `delete this ${config.noun.toLowerCase()}`)
    await repository.delete(access.workspaceId, id)
    await recordAudit(repos, access, `${config.auditType}.deleted`, { type: config.auditType, id }, { title: item.title })
    return json({ ok: true })
  })

  return { GET, DELETE }
}
