import 'server-only'

import { NextResponse, type NextRequest } from 'next/server'

import { safeRedirectPath } from '@/lib/safe-redirect'
import { setSessionCookie } from '@/server/auth/current-user'
import { completeLogin } from '@/server/auth/login'
import { OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS, OAuthFailure, beginAuthorization, completeAuthorization } from '@/server/auth/oauth'
import { getSecretKeys, shouldUseSecureCookies, type OAuthProviderId } from '@/server/env'
import { isAppError } from '@/server/http/errors'
import { isSchemaMissing } from '@/server/http/route'
import { log } from '@/server/logger'
import { getServices } from '@/server/services'

const STATE_COOKIE_PATH = '/api/auth/oauth'

function loginRedirect(req: NextRequest, code: string) {
  const url = new URL('/login', req.url)
  url.searchParams.set('error', code)
  const res = NextResponse.redirect(url)
  res.cookies.set(OAUTH_STATE_COOKIE, '', { path: STATE_COOKIE_PATH, maxAge: 0 })
  return res
}

export async function startOAuth(req: NextRequest, provider: OAuthProviderId) {
  try {
    const nextPath = safeRedirectPath(req.nextUrl.searchParams.get('next'))
    const { authorizationUrl, stateCookie } = await beginAuthorization(provider, req.url, nextPath, getSecretKeys())
    const res = NextResponse.redirect(authorizationUrl)
    res.cookies.set(OAUTH_STATE_COOKIE, stateCookie, {
      httpOnly: true,
      secure: shouldUseSecureCookies(),
      sameSite: 'lax',
      path: STATE_COOKIE_PATH,
      maxAge: OAUTH_STATE_TTL_SECONDS,
    })
    return res
  } catch (error) {
    if (error instanceof OAuthFailure) return loginRedirect(req, error.code)
    if (isAppError(error) && error.code === 'APP_URL_MISSING') {
      log.warn('OAuth sign-in needs APP_URL in production', { provider })
      return loginRedirect(req, 'app_url_missing')
    }
    log.error('Could not start OAuth sign-in', error, { provider })
    return loginRedirect(req, 'server_error')
  }
}

export async function finishOAuth(req: NextRequest) {
  const params = req.nextUrl.searchParams
  if (params.get('error')) return loginRedirect(req, 'oauth_denied')
  try {
    const identity = await completeAuthorization({
      provider: params.get('provider'),
      code: params.get('code'),
      state: params.get('state'),
      cookieValue: req.cookies.get(OAUTH_STATE_COOKIE)?.value,
      requestUrl: req.url,
      secret: getSecretKeys(),
    })
    const { token } = await completeLogin(getServices().repos, identity, req.headers.get('user-agent'))
    const res = NextResponse.redirect(new URL(safeRedirectPath(identity.nextPath), req.url))
    setSessionCookie(res, token)
    res.cookies.set(OAUTH_STATE_COOKIE, '', { path: STATE_COOKIE_PATH, maxAge: 0 })
    return res
  } catch (error) {
    if (error instanceof OAuthFailure) return loginRedirect(req, error.code)
    if (isAppError(error) && error.code === 'APP_URL_MISSING') return loginRedirect(req, 'app_url_missing')
    if (isAppError(error) && error.status === 403) return loginRedirect(req, 'not_allowed')
    if (isSchemaMissing(error)) return loginRedirect(req, 'schema_missing')
    log.error('OAuth callback failed', error)
    return loginRedirect(req, 'server_error')
  }
}
