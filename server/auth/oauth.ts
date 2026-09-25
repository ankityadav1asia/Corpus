import 'server-only'

import { base64UrlEncode, signToken, verifyToken } from '@/server/auth/session'
import { getAppOrigin, getOAuthClient, type OAuthProviderId } from '@/server/env'
import { secretsEqual } from '@/server/security/compare'
import type { SecretKeys } from '@/server/security/keys'

export const OAUTH_STATE_COOKIE = 'corpus_oauth'
export const OAUTH_STATE_TTL_SECONDS = 600

export class OAuthFailure extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'OAuthFailure'
  }
}

export function isOAuthProvider(value: string | null): value is OAuthProviderId {
  return value === 'google' || value === 'github'
}

/** Must stay identical to the redirect URI registered in the Google / GitHub consoles. */
export function redirectUriFor(provider: OAuthProviderId, requestUrl: string) {
  return `${getAppOrigin(requestUrl)}/api/auth/oauth/callback?provider=${provider}`
}

export function randomToken(bytes = 32) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

interface StatePayload {
  p: OAuthProviderId
  s: string
  v: string
  n: string
  exp: number
}

/**
 * Builds the provider authorisation URL. `state` (CSRF) and the PKCE verifier are kept in a
 * signed, short-lived, httpOnly cookie — the old flow had neither, so a forged callback could
 * log a victim into an attacker-chosen account.
 */
export async function beginAuthorization(provider: OAuthProviderId, requestUrl: string, nextPath: string, secret: SecretKeys) {
  const client = getOAuthClient(provider)
  if (!client) throw new OAuthFailure(`${provider}_not_configured`)

  const state = randomToken()
  const verifier = randomToken(48)
  const challenge = await pkceChallenge(verifier)
  const redirectUri = redirectUriFor(provider, requestUrl)

  const url = provider === 'google' ? new URL('https://accounts.google.com/o/oauth2/v2/auth') : new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (provider === 'google') {
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'openid email profile')
    url.searchParams.set('prompt', 'select_account')
  } else {
    url.searchParams.set('scope', 'read:user user:email')
    url.searchParams.set('allow_signup', 'true')
  }

  const payload: StatePayload = {
    p: provider,
    s: state,
    v: verifier,
    n: nextPath,
    exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS,
  }
  return { authorizationUrl: url.toString(), stateCookie: await signToken(payload, secret) }
}

async function readState(cookieValue: string | undefined, secret: SecretKeys): Promise<StatePayload> {
  if (!cookieValue) throw new OAuthFailure('state_missing')
  const payload = (await verifyToken(cookieValue, secret)) as Partial<StatePayload> | null
  if (
    !payload ||
    !isOAuthProvider(payload.p ?? null) ||
    typeof payload.s !== 'string' ||
    typeof payload.v !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp * 1000 < Date.now()
  ) {
    throw new OAuthFailure('state_invalid')
  }
  return payload as StatePayload
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new OAuthFailure('provider_error')
  return (await response.json()) as Record<string, unknown>
}

export interface VerifiedIdentity {
  email: string
  name: string | null
  nextPath: string
}

export async function completeAuthorization(input: {
  provider: string | null
  code: string | null
  state: string | null
  cookieValue: string | undefined
  requestUrl: string
  secret: SecretKeys
}): Promise<VerifiedIdentity> {
  if (!isOAuthProvider(input.provider)) throw new OAuthFailure('auth_failed')
  const saved = await readState(input.cookieValue, input.secret)
  if (saved.p !== input.provider || !input.state || !secretsEqual(saved.s, input.state)) throw new OAuthFailure('state_invalid')
  if (!input.code) throw new OAuthFailure('missing_code')

  const client = getOAuthClient(input.provider)
  if (!client) throw new OAuthFailure(`${input.provider}_not_configured`)
  const redirectUri = redirectUriFor(input.provider, input.requestUrl)

  if (input.provider === 'google') {
    const token = await fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: saved.v,
      }),
    })
    if (typeof token.access_token !== 'string') throw new OAuthFailure('google_token_failed')
    const profile = await fetchJson('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    })
    if (typeof profile.email !== 'string' || profile.email_verified !== true) throw new OAuthFailure('google_no_email')
    return {
      email: profile.email.toLowerCase(),
      name: typeof profile.name === 'string' ? profile.name : null,
      nextPath: saved.n,
    }
  }

  const token = await fetchJson('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: input.code,
      redirect_uri: redirectUri,
      code_verifier: saved.v,
    }),
  })
  if (typeof token.access_token !== 'string') throw new OAuthFailure('github_token_failed')
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'corpus-rag',
  }
  const [profile, emails] = await Promise.all([
    fetchJson('https://api.github.com/user', { headers }),
    fetch('https://api.github.com/user/emails', { headers, signal: AbortSignal.timeout(10_000) }).then(async (response) => {
      if (!response.ok) throw new OAuthFailure('github_no_email')
      return (await response.json()) as Array<{ email: string; primary: boolean; verified: boolean }>
    }),
  ])
  // Only a verified primary address proves ownership; the public profile email may be unverified.
  const primary = Array.isArray(emails) ? emails.find((entry) => entry.primary && entry.verified) : undefined
  if (!primary?.email) throw new OAuthFailure('github_no_email')
  const name = typeof profile.name === 'string' ? profile.name : typeof profile.login === 'string' ? profile.login : null
  return { email: primary.email.toLowerCase(), name, nextPath: saved.n }
}
