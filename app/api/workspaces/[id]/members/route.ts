import { memberInviteSchema } from '@/lib/contracts'
import { isGuestEmail } from '@/server/auth/guest'
import { readJson } from '@/server/http/body'
import { json, workspaceParamRoute } from '@/server/http/route'
import { getServices } from '@/server/services'
import { addMemberByEmail } from '@/server/workspaces/members'

/**
 * Members and pending invitations (any member can see who is in the workspace; invitations: admins).
 * Demo visitors are left out: they come and go, and see only themselves.
 */
export const GET = workspaceParamRoute(async ({ access }) => {
  const { repos } = getServices()
  const [members, invites] = await Promise.all([
    repos.workspaces.members(access.workspaceId),
    access.role === 'admin' ? repos.workspaces.invites(access.workspaceId) : Promise.resolve([]),
  ])
  if (access.isGuest) return json({ members: members.filter((member) => member.userId === access.userId), invites: [] })
  return json({ members: members.filter((member) => !isGuestEmail(member.email)), invites })
})

/** Adds an existing account, or invites an address (workspace Admin). */
export const POST = workspaceParamRoute(async ({ req, access, user }) => {
  const input = await readJson(req, memberInviteSchema)
  const status = await addMemberByEmail(getServices().repos, access, user, input)
  return json({ status }, { status: 201 })
})
