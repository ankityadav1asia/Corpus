import { getAppOrigin, getSecretKeys } from '@/server/env'
import { json, workspaceParamRoute } from '@/server/http/route'
import { getServices } from '@/server/services'
import { listWorkspaceShares } from '@/server/shares/service'

/** Every active public link of the workspace, to review and revoke (workspace Admin). */
export const GET = workspaceParamRoute(async ({ req, access }) => {
  const links = await listWorkspaceShares(getServices().repos, access, getAppOrigin(req.url), getSecretKeys())
  return json({ links })
})
