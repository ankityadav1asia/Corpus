import type { Role } from '@/lib/constants'
import type { SessionUser } from '@/lib/contracts'
import { notify, recordAudit } from '@/server/activity'
import { requireWorkspacePermission, type WorkspaceAccess } from '@/server/auth/access'
import { Errors } from '@/server/http/errors'
import type { Repositories } from '@/server/repositories'
import type { MembershipChange } from '@/server/repositories/workspaces'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'

type MemberRepos = Pick<Repositories, 'workspaces' | 'audit' | 'notifications' | 'rateLimits'>

function assertChanged(result: MembershipChange) {
  if (result === 'not_found') throw Errors.notFound('Member')
  if (result === 'last_admin') throw Errors.conflict('A workspace needs at least one admin. Promote someone else first.')
}

/**
 * Adds someone by email (workspace Admin). Existing accounts become members immediately; other
 * addresses get an invitation that is accepted automatically when they first sign in.
 */
export async function addMemberByEmail(repos: MemberRepos, access: WorkspaceAccess, actor: SessionUser, input: { email: string; role: Role }): Promise<'added' | 'invited'> {
  requireWorkspacePermission(access, 'members.manage')
  if (access.isPersonal) throw Errors.badRequest('Personal workspaces cannot be shared. Create a team workspace instead.')
  await enforceRateLimit(repos, `invite:user:${actor.id}`, RATE_LIMITS.invites)

  const existingUserId = await repos.workspaces.findUserIdByEmail(input.email)
  if (!existingUserId) {
    await repos.workspaces.upsertInvite(access.workspaceId, input.email, input.role, actor.id)
    await recordAudit(repos, access, 'member.invited', null, input)
    return 'invited'
  }
  if (await repos.workspaces.membership(access.workspaceId, existingUserId)) throw Errors.conflict('That person is already a member.')
  await repos.workspaces.addMember(access.workspaceId, existingUserId, input.role)
  await recordAudit(repos, access, 'member.added', { type: 'user', id: existingUserId }, input)
  const workspace = await repos.workspaces.summary(access.workspaceId, actor.id)
  await notify(repos, {
    userId: existingUserId,
    workspaceId: access.workspaceId,
    kind: 'member_added',
    title: `You were added to “${workspace?.name ?? 'a workspace'}”`,
    body: `${actor.name ?? actor.email} gave you ${input.role} access.`,
    link: { tab: 'chat' },
  })
  return 'added'
}

/** Changes a member's workspace role (workspace Admin). */
export async function changeMemberRole(repos: MemberRepos, access: WorkspaceAccess, memberId: string, role: Role): Promise<void> {
  requireWorkspacePermission(access, 'members.manage')
  if (access.isPersonal) throw Errors.badRequest('Personal workspaces have a single owner.')
  assertChanged(await repos.workspaces.setRole(access.workspaceId, memberId, role))
  await recordAudit(repos, access, 'member.role_changed', { type: 'user', id: memberId }, { role })
}

/**
 * Removes a member (workspace Admin), or lets a member leave. Their connected accounts and public
 * links go with them (server/repositories/workspaces.ts → removeMember).
 */
export async function removeMember(repos: MemberRepos, access: WorkspaceAccess, memberId: string): Promise<void> {
  const leaving = memberId === access.userId
  if (!leaving) requireWorkspacePermission(access, 'members.manage')
  if (access.isPersonal) throw Errors.badRequest('You cannot leave your personal workspace.')
  assertChanged(await repos.workspaces.removeMember(access.workspaceId, memberId))
  await recordAudit(repos, access, leaving ? 'member.left' : 'member.removed', { type: 'user', id: memberId })
}
