import { z } from 'zod'

import { recordAudit } from '@/server/activity'
import { requireWorkspacePermission } from '@/server/auth/access'
import { readSearchParams } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceParamRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

const revokeQuery = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) })

/** Revokes a pending invitation (workspace Admin). */
export const DELETE = workspaceParamRoute(async ({ req, access }) => {
  const { email } = readSearchParams(req, revokeQuery)
  const { repos } = getServices()
  requireWorkspacePermission(access, 'members.manage')
  if (!(await repos.workspaces.deleteInvite(access.workspaceId, email))) throw Errors.notFound('Invitation')
  await recordAudit(repos, access, 'invite.revoked', null, { email })
  return json({ ok: true })
})
