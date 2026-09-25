import { collectionRoleSchema, idSchema, type CollectionRoleEntry } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireCollectionPermission } from '@/server/auth/access'
import { effectiveCollectionRole } from '@/server/auth/permissions'
import { parseWith, readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

type Params = { id: string }

/** Workspace members with their per-notebook override and resulting role (notebook Admin). */
export const GET = workspaceRoute<Params>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  await requireCollectionPermission(repos, access, id, 'collection.manage')
  const [members, overrides] = await Promise.all([repos.workspaces.members(access.workspaceId), repos.collections.roleOverrides(id)])
  const byUser = new Map(overrides.map((entry) => [entry.userId, entry.role]))
  const roles: CollectionRoleEntry[] = members.map((member) => {
    const override = byUser.get(member.userId) ?? null
    return {
      userId: member.userId,
      email: member.email,
      name: member.name,
      workspaceRole: member.role,
      override,
      effectiveRole: effectiveCollectionRole(member.role, override) ?? member.role,
    }
  })
  return json({ roles })
})

/** Sets (role) or clears (null) a member's override on this notebook (notebook Admin). */
export const PUT = workspaceRoute<Params>(async ({ req, params, access }) => {
  const id = parseWith(idSchema, params.id)
  const input = await readJson(req, collectionRoleSchema)
  const { repos } = getServices()
  const { collection } = await requireCollectionPermission(repos, access, id, 'collection.manage')
  const membership = await repos.workspaces.membership(access.workspaceId, input.userId)
  if (!membership) throw Errors.notFound('Member')
  if (membership.role === 'admin') throw Errors.badRequest('Workspace admins always have Admin access to every notebook.')
  await repos.collections.setRoleOverride(id, input.userId, input.role)
  await recordAudit(repos, access, 'notebook.access_changed', { type: 'user', id: input.userId }, { notebook: collection.name, role: input.role ?? 'workspace role' })
  return json({ ok: true })
})
