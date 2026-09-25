import { workspaceUpdateSchema, type WorkspaceDetail } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireWorkspacePermission } from '@/server/auth/access'
import { readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceParamRoute } from '@/server/http/route'
import type { Repositories } from '@/server/repositories'
import { mergeSettings } from '@/server/repositories/workspaces'
import { getServices } from '@/server/services'

async function workspaceDetail(repos: Repositories, workspaceId: string, userId: string) {
  const [summary, settings] = await Promise.all([repos.workspaces.summary(workspaceId, userId), repos.workspaces.settings(workspaceId)])
  if (!summary) throw Errors.notFound('Workspace')
  return json<{ workspace: WorkspaceDetail }>({ workspace: { ...summary, settings } })
}

export const GET = workspaceParamRoute(async ({ access }) => workspaceDetail(getServices().repos, access.workspaceId, access.userId))

/** Rename and/or change retrieval, guardrail and evaluation settings (workspace Admin). */
export const PATCH = workspaceParamRoute(async ({ req, access }) => {
  const input = await readJson(req, workspaceUpdateSchema)
  const { repos } = getServices()
  requireWorkspacePermission(access, 'workspace.manage')
  if (input.name !== undefined) {
    await repos.workspaces.rename(access.workspaceId, input.name)
    await recordAudit(repos, access, 'workspace.renamed', null, { name: input.name })
  }
  if (input.settings) {
    await repos.workspaces.saveSettings(access.workspaceId, mergeSettings(await repos.workspaces.settings(access.workspaceId), input.settings))
    await recordAudit(repos, access, 'workspace.settings_changed', null, input.settings)
  }
  return workspaceDetail(repos, access.workspaceId, access.userId)
})

/** Deletes a team workspace with all of its content (workspace Admin). Personal workspaces stay. */
export const DELETE = workspaceParamRoute(async ({ access }) => {
  const { repos } = getServices()
  requireWorkspacePermission(access, 'workspace.manage')
  if (access.isPersonal) throw Errors.badRequest('Your personal workspace cannot be deleted.')
  if (!(await repos.workspaces.delete(access.workspaceId))) throw Errors.notFound('Workspace')
  return json({ ok: true })
})
