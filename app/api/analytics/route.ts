import { analyticsQuerySchema } from '@/lib/contracts'
import { requireWorkspacePermission } from '@/server/auth/access'
import { readSearchParams } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/** Usage and latency: your own questions, or (workspace admins) everyone's in the workspace. */
export const GET = workspaceRoute(async ({ req, access }) => {
  const { scope } = readSearchParams(req, analyticsQuerySchema)
  if (scope === 'workspace') requireWorkspacePermission(access, 'analytics.workspace')
  return json(await getServices().repos.analytics.summary({ workspaceId: access.workspaceId, ownerId: scope === 'me' ? access.userId : null }))
})
