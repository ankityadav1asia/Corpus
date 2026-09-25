import { memberInviteSchema } from '@/lib/contracts'
import { readJson } from '@/server/http/body'
import { json, workspaceParamRoute } from '@/server/http/route'
import { getServices } from '@/server/services'
import { addMemberByEmail } from '@/server/workspaces/members'

/** Members and pending invitations (any member can see who is in the workspace; invitations: admins). */
export const GET = workspaceParamRoute(async ({ access }) => {
  const { repos } = getServices()
  const [members, invites] = await Promise.all([
    repos.workspaces.members(access.workspaceId),
    access.role === 'admin' ? repos.workspaces.invites(access.workspaceId) : Promise.resolve([]),
  ])
  return json({ members, invites })
})

/** Adds an existing account, or invites an address (workspace Admin). */
export const POST = workspaceParamRoute(async ({ req, access, user }) => {
  const input = await readJson(req, memberInviteSchema)
  const status = await addMemberByEmail(getServices().repos, access, user, input)
  return json({ status }, { status: 201 })
})
