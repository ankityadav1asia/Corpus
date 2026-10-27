import { workspaceCreateSchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { GUEST_DENIED_MESSAGE } from '@/server/auth/permissions'
import { readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { authedRoute, json } from '@/server/http/route'
import { getServices } from '@/server/services'

const MAX_WORKSPACES_CREATED = 20

/** Workspaces the caller belongs to, personal workspace first. Demo visitors have no personal workspace. */
export const GET = authedRoute(async ({ user }) => {
  const { repos } = getServices()
  if (!user.guest) await repos.workspaces.ensurePersonal(user.id)
  return json({ workspaces: await repos.workspaces.listForUser(user.id) })
})

/** Creates a team workspace; the creator becomes its admin. */
export const POST = authedRoute(async ({ req, user }) => {
  if (user.guest) throw Errors.forbidden(GUEST_DENIED_MESSAGE)
  const { name } = await readJson(req, workspaceCreateSchema)
  const { repos } = getServices()
  const mine = await repos.workspaces.listForUser(user.id)
  if (mine.filter((workspace) => !workspace.isPersonal && workspace.role === 'admin').length >= MAX_WORKSPACES_CREATED) {
    throw Errors.conflict(`You can administer at most ${MAX_WORKSPACES_CREATED} team workspaces.`)
  }
  const workspace = await repos.workspaces.create(name, user.id)
  await repos.collections.ensureDefault(workspace.id, user.id)
  await recordAudit(repos, { workspaceId: workspace.id, userId: user.id }, 'workspace.created', null, { name })
  return json({ workspace }, { status: 201 })
})
