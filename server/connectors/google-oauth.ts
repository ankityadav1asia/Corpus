import 'server-only'

import { pkceChallenge, randomToken } from '@/server/auth/oauth'
import { signToken, verifyToken } from '@/server/auth/session'
import { ConnectorError } from '@/server/connectors/types'
import { getAppOrigin, getOAuthClient } from '@/server/env'
import { secretsEqual } from '@/server/security/compare'
import type { SecretKeys } from '@/server/security/keys'

/**
 * OAuth for connecting a Google Drive (separate from sign-in): read-only Drive scope, offline access
 * for scheduled syncs, PKCE, and state bound to the member and workspace in a signed short-lived cookie.
 */

export const DRIVE_STATE_COOKIE = 'corpus_drive_oauth'
export const DRIVE_STATE_TTL_SECONDS = 600
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.readonly'

interface DriveState {
  s: string
  v: string
  w: string
  u: string
  exp: number
}

export function driveRedirectUri(requestUrl: string) {
  return `${getAppOrigin(requestUrl)}/api/connectors/google-drive/callback`
}

export async function beginDriveAuthorization(requestUrl: string, workspaceId: string, userId: string, secret: SecretKeys) {
  const client = getOAuthClient('google')
  if (!client) throw new ConnectorError('Google Drive is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).')
  const state = randomToken()
  const verifier = randomToken(48)
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', driveRedirectUri(requestUrl))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', await pkceChallenge(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  const payload: DriveState = { s: state, v: verifier, w: workspaceId, u: userId, exp: Math.floor(Date.now() / 1000) + DRIVE_STATE_TTL_SECONDS }
  return { authorizationUrl: url.toString(), stateCookie: await signToken(payload, secret) }
}

export interface DriveGrant {
  workspaceId: string
  email: string
  credentials: Record<string, string>
}

interface DriveCallback {
  code: string | null
  state: string | null
  cookieValue: string | undefined
  requestUrl: string
  userId: string
  secret: SecretKeys
  fetch?: typeof fetch
}

/** The state saved when this member started connecting; it must be unexpired and match Google's. */
async function verifiedDriveState(input: DriveCallback): Promise<DriveState> {
  const saved = input.cookieValue ? ((await verifyToken(input.cookieValue, input.secret)) as Partial<DriveState> | null) : null
  const complete = saved && typeof saved.s === 'string' && typeof saved.v === 'string' && typeof saved.w === 'string'
  if (!complete || saved.u !== input.userId || (saved.exp ?? 0) * 1000 < Date.now()) {
    throw new ConnectorError('The Google sign-in expired or did not start here. Try connecting again.')
  }
  if (!input.state || !secretsEqual(saved.s!, input.state)) throw new ConnectorError('The Google sign-in could not be verified. Try connecting again.')
  return saved as DriveState
}

interface DriveToken {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

/** Exchanges the code (with the PKCE verifier) for tokens, which must include offline, read-only Drive access. */
async function exchangeDriveCode(doFetch: typeof fetch, input: { code: string; verifier: string; requestUrl: string }): Promise<DriveToken> {
  const client = getOAuthClient('google')
  if (!client) throw new ConnectorError('Google Drive is not configured on this server.')
  const response = await doFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: driveRedirectUri(input.requestUrl),
      grant_type: 'authorization_code',
      code_verifier: input.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new ConnectorError('Google rejected the sign-in. Try connecting again.', response.status)
  const token = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }
  if (!token.access_token || !token.refresh_token)
    throw new ConnectorError('Google did not return offline access. Remove Corpus from your Google account permissions and connect again.')
  if (!token.scope?.includes('drive.readonly')) throw new ConnectorError('Access to Google Drive was not granted. Tick the Drive permission when connecting.')
  return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresIn: token.expires_in ?? 3600 }
}

/** The Google account's address, shown on the connection ("Google Drive" when it cannot be read). */
async function accountEmail(doFetch: typeof fetch, accessToken: string): Promise<string> {
  const profile = await doFetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  })
  return profile.ok ? (((await profile.json()) as { email?: string }).email ?? 'Google Drive') : 'Google Drive'
}

export async function completeDriveAuthorization(input: DriveCallback): Promise<DriveGrant> {
  const doFetch = input.fetch ?? fetch
  const saved = await verifiedDriveState(input)
  if (!input.code) throw new ConnectorError('Google did not grant access.')
  const token = await exchangeDriveCode(doFetch, { code: input.code, verifier: saved.v, requestUrl: input.requestUrl })
  const email = await accountEmail(doFetch, token.accessToken)
  return {
    workspaceId: saved.w,
    email,
    credentials: { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: String(Date.now() + token.expiresIn * 1000), email },
  }
}
