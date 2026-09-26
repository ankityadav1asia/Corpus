import { NextResponse } from 'next/server'

import { idSchema } from '@/lib/contracts'
import { requireWorkspacePermission, resolveWorkspaceAccess } from '@/server/auth/access'
import { DRIVE_STATE_COOKIE, DRIVE_STATE_TTL_SECONDS, beginDriveAuthorization } from '@/server/connectors/google-oauth'
import { withConnectorErrors } from '@/server/connectors/service'
import { getSecretKeys, shouldUseSecureCookies } from '@/server/env'
import { parseWith } from '@/server/http/body'
import { authedRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/** Starts connecting a Google Drive to workspace `?w=` (Editor). A top-level navigation, not fetch. */
export const GET = authedRoute(async ({ req, user }) => {
  const workspaceId = parseWith(idSchema, req.nextUrl.searchParams.get('w'))
  const access = await resolveWorkspaceAccess(getServices().repos, user.id, workspaceId, { guest: user.guest })
  requireWorkspacePermission(access, 'connectors.use')
  const { authorizationUrl, stateCookie } = await withConnectorErrors(() => beginDriveAuthorization(req.url, workspaceId, user.id, getSecretKeys()))
  const res = NextResponse.redirect(authorizationUrl)
  res.cookies.set(DRIVE_STATE_COOKIE, stateCookie, {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: 'lax',
    path: '/api/connectors/google-drive',
    maxAge: DRIVE_STATE_TTL_SECONDS,
  })
  return res
})
