import { idSchema, memberRoleSchema } from '@/lib/contracts'
import { parseWith, readJson } from '@/server/http/body'
import { json, workspaceParamRoute } from '@/server/http/route'
import { getServices } from '@/server/services'
import { changeMemberRole, removeMember } from '@/server/workspaces/members'

type Params = { id: string; userId: string }

/** Changes a member's workspace role (workspace Admin). */
export const PATCH = workspaceParamRoute<Params>(async ({ req, params, access }) => {
  const memberId = parseWith(idSchema, params.userId)
  const { role } = await readJson(req, memberRoleSchema)
  await changeMemberRole(getServices().repos, access, memberId, role)
  return json({ ok: true })
})

/** Removes a member (workspace Admin), or lets a member leave. */
export const DELETE = workspaceParamRoute<Params>(async ({ params, access }) => {
  await removeMember(getServices().repos, access, parseWith(idSchema, params.userId))
  return json({ ok: true })
})
