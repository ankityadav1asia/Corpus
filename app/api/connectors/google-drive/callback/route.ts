import { NextResponse, type NextRequest } from 'next/server'

import { recordAudit } from '@/server/activity'
import { requireWorkspacePermission, resolveWorkspaceAccess } from '@/server/auth/access'
import { DRIVE_STATE_COOKIE, completeDriveAuthorization } from '@/server/connectors/google-oauth'
import { ConnectorError } from '@/server/connectors/types'
import { getSecretKeys } from '@/server/env'
import { authedRoute } from '@/server/http/route'
import { log } from '@/server/logger'
import { sealSecret } from '@/server/security/secrets'
import { getServices } from '@/server/services'

/** Back to the app with a status code (never free text in the URL: it would be shown to the user). */
function back(req: NextRequest, workspaceId: string | null, result: 'connected' | 'denied' | 'failed') {
  const url = new URL('/', req.url)
  if (workspaceId) url.searchParams.set('w', workspaceId)
  url.searchParams.set('connector', `google_drive:${result}`)
  const res = NextResponse.redirect(url)
  res.cookies.set(DRIVE_STATE_COOKIE, '', { path: '/api/connectors/google-drive', maxAge: 0 })
  return res
}

/** Google redirects here after the member approved (or declined) Drive access. */
export const GET = authedRoute(async ({ req, user }) => {
  const params = req.nextUrl.searchParams
  if (params.get('error')) return back(req, null, 'denied')
  const services = getServices()
  try {
    const grant = await completeDriveAuthorization({
      code: params.get('code'),
      state: params.get('state'),
      cookieValue: req.cookies.get(DRIVE_STATE_COOKIE)?.value,
      requestUrl: req.url,
      userId: user.id,
      secret: getSecretKeys(),
    })
    const access = await resolveWorkspaceAccess(services.repos, user.id, grant.workspaceId, { guest: user.guest })
    requireWorkspacePermission(access, 'connectors.use')
    const connection = await services.repos.connectors.saveConnection({
      workspaceId: grant.workspaceId,
      userId: user.id,
      provider: 'google_drive',
      accountLabel: grant.email,
      credentials: await sealSecret(JSON.stringify(grant.credentials), getSecretKeys()),
    })
    await recordAudit(services.repos, access, 'connector.connected', { type: 'connection', id: connection.id }, { provider: 'google_drive', account: grant.email })
    return back(req, grant.workspaceId, 'connected')
  } catch (error) {
    if (!(error instanceof ConnectorError)) log.error('Google Drive connection failed', error)
    else log.warn('Google Drive connection refused', { reason: error.message })
    return back(req, null, 'failed')
  }
})
