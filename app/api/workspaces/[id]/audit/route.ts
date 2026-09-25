import type { AuditEvent } from '@/lib/contracts'
import { requireWorkspacePermission } from '@/server/auth/access'
import { json, workspaceParamRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/** Recent changes in the workspace — members, settings, notebooks, content (workspace Admin). */
export const GET = workspaceParamRoute(async ({ access }) => {
  requireWorkspacePermission(access, 'workspace.manage')
  return json<{ events: AuditEvent[] }>({ events: await getServices().repos.audit.list(access.workspaceId, 100) })
})
