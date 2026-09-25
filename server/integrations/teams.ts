import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto'

import { PermanentJobError } from '@/server/jobs/errors'

/**
 * Microsoft Teams bot over the Bot Framework (Azure Bot resource). Incoming activities carry a JWT
 * signed by the Bot Framework; it is verified here (signature against Microsoft's published keys,
 * issuer, audience = our App ID, expiry, and the service URL it was issued for). Replies are
 * posted back to that service URL with a token obtained by client credentials.
 */

const OPENID_CONFIG = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
const ISSUER = 'https://api.botframework.com'
const TOKEN_SCOPE = 'https://api.botframework.com/.default'
const CLOCK_SKEW_SECONDS = 5 * 60
const KEYS_TTL_MS = 12 * 60 * 60 * 1000
/** Unknown key ids trigger a refresh at most this often (a forged kid must not make us fetch per request). */
const KEYS_REFRESH_MIN_MS = 5 * 60 * 1000

type Fetch = typeof fetch

export interface TeamsCredentials {
  appId: string
  appPassword: string
  tenantId: string | null
}

interface Jwk {
  kid: string
  kty: string
  n: string
  e: string
  endorsements?: string[]
}

export interface TeamsActivity {
  id: string
  serviceUrl: string
  channelId: string
  conversationId: string
  text: string
}

/** Only Microsoft's Bot Connector hosts receive replies (the URL comes from the request). */
export function isAllowedServiceUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
    const host = url.hostname.toLowerCase()
    return host === 'smba.trafficmanager.net' || ['.botframework.com', '.botframework.us', '.teams.microsoft.com', '.teams.microsoft.us'].some((suffix) => host.endsWith(suffix))
  } catch {
    return false
  }
}

/** Teams sends the bot's @mention as <at>Name</at>, sometimes with HTML around the text. */
export function cleanTeamsText(text: string): string {
  return text
    .replace(/<at>[^<]*<\/at>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A user's message to the bot, or null for other activity types (typing, reactions, installs…). */
export function parseTeamsActivity(payload: unknown): TeamsActivity | null {
  if (!payload || typeof payload !== 'object') return null
  const activity = payload as Record<string, unknown>
  const conversation = activity.conversation as Record<string, unknown> | undefined
  if (
    activity.type !== 'message' ||
    typeof activity.text !== 'string' ||
    typeof activity.id !== 'string' ||
    typeof activity.serviceUrl !== 'string' ||
    typeof conversation?.id !== 'string'
  ) {
    return null
  }
  const text = cleanTeamsText(activity.text)
  if (!text) return null
  return {
    id: activity.id,
    serviceUrl: activity.serviceUrl,
    channelId: typeof activity.channelId === 'string' ? activity.channelId : 'msteams',
    conversationId: conversation.id,
    text,
  }
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

interface VerifyInput {
  authorization: string | null
  appId: string
  serviceUrl: string
  channelId: string
  now?: number
}

/** The parts of a bearer JWT signed with RS256; null when malformed. */
function readBearerToken(authorization: string | null) {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1]
  const parts = token?.split('.')
  if (!parts || parts.length !== 3) return null
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
  const header = decodeSegment(headerPart)
  const claims = decodeSegment(payloadPart)
  const kid = header?.kid
  if (!claims || header?.alg !== 'RS256' || typeof kid !== 'string') return null
  return { kid, claims, signed: `${headerPart}.${payloadPart}`, signature: signaturePart }
}

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, '')

/** Issuer, audience, lifetime and service URL (the signature is checked separately). */
function claimsAreValid(claims: Record<string, unknown>, input: VerifyInput): boolean {
  const now = Math.floor((input.now ?? Date.now()) / 1000)
  if (claims.iss !== ISSUER) return false
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audience.includes(input.appId)) return false
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) return false
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > now) return false
  // The token must name the service URL it was issued for, and the activity must not point elsewhere.
  return typeof claims.serviceurl === 'string' && withoutTrailingSlash(claims.serviceurl) === withoutTrailingSlash(input.serviceUrl)
}

/** Verifies Bot Framework tokens; Microsoft's signing keys are cached and refreshed on an unknown key id. */
export function createBotFrameworkVerifier(fetcher: Fetch) {
  let cache: { keys: Jwk[]; fetchedAt: number } | null = null

  async function loadKeys(force: boolean): Promise<Jwk[]> {
    if (cache && Date.now() - cache.fetchedAt < (force ? KEYS_REFRESH_MIN_MS : KEYS_TTL_MS)) return cache.keys
    const config = (await (await fetcher(OPENID_CONFIG, { signal: AbortSignal.timeout(10_000) })).json()) as { jwks_uri?: string }
    if (!config.jwks_uri || !config.jwks_uri.startsWith('https://login.botframework.com/')) throw new Error('Unexpected Bot Framework key location')
    const jwks = (await (await fetcher(config.jwks_uri, { signal: AbortSignal.timeout(10_000) })).json()) as { keys?: Jwk[] }
    cache = { keys: (jwks.keys ?? []).filter((key) => key.kty === 'RSA' && key.kid && key.n && key.e), fetchedAt: Date.now() }
    return cache.keys
  }

  return async function verify(input: VerifyInput): Promise<boolean> {
    const token = readBearerToken(input.authorization)
    if (!token || !claimsAreValid(token.claims, input)) return false

    let key = (await loadKeys(false)).find((candidate) => candidate.kid === token.kid)
    key ??= (await loadKeys(true)).find((candidate) => candidate.kid === token.kid)
    if (!key) return false
    if (Array.isArray(key.endorsements) && key.endorsements.length > 0 && !key.endorsements.includes(input.channelId)) return false

    try {
      const publicKey = createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e } as JsonWebKey, format: 'jwk' })
      return verifySignature('RSA-SHA256', Buffer.from(token.signed), publicKey, Buffer.from(token.signature, 'base64url'))
    } catch {
      return false
    }
  }
}

const tokenCache = new Map<string, { token: string; expires: number }>()

/** An access token for replying (client credentials of the bot's Microsoft Entra app). */
export async function getBotToken(fetcher: Fetch, credentials: TeamsCredentials): Promise<string> {
  const cacheKey = `${credentials.tenantId ?? 'botframework.com'}:${credentials.appId}`
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expires > Date.now()) return cached.token
  const tenant = credentials.tenantId ?? 'botframework.com'
  let response: Response
  try {
    response = await fetcher(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials.appId, client_secret: credentials.appPassword, scope: TOKEN_SCOPE }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('Microsoft sign-in could not be reached')
  }
  const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
  if (response.status === 400 || response.status === 401) throw new PermanentJobError('Microsoft rejected the bot credentials. Check the App ID, client secret and tenant.')
  if (!response.ok || !data.access_token) throw new Error(`Microsoft sign-in failed (${response.status})`)
  tokenCache.set(cacheKey, { token: data.access_token, expires: Date.now() + Math.max(60, (data.expires_in ?? 3600) - 120) * 1000 })
  return data.access_token
}

async function connectorPost(fetcher: Fetch, token: string, url: string, body: Record<string, unknown>) {
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('Microsoft Teams could not be reached')
  }
  if (response.status === 401 || response.status === 403) throw new PermanentJobError(`Microsoft Teams refused the reply (${response.status}).`)
  if (!response.ok) throw new Error(`Microsoft Teams reply failed (${response.status})`)
}

function conversationUrl(serviceUrl: string, conversationId: string) {
  if (!isAllowedServiceUrl(serviceUrl)) throw new PermanentJobError('Unexpected Teams service URL.')
  return `${serviceUrl.replace(/\/+$/, '')}/v3/conversations/${encodeURIComponent(conversationId)}/activities`
}

/** Shows "typing…" while the answer is prepared. */
export async function sendTeamsTyping(fetcher: Fetch, token: string, activity: Pick<TeamsActivity, 'serviceUrl' | 'conversationId'>): Promise<void> {
  await connectorPost(fetcher, token, conversationUrl(activity.serviceUrl, activity.conversationId), { type: 'typing' })
}

export async function replyInTeams(fetcher: Fetch, token: string, activity: Pick<TeamsActivity, 'serviceUrl' | 'conversationId' | 'id'>, text: string): Promise<void> {
  await connectorPost(fetcher, token, `${conversationUrl(activity.serviceUrl, activity.conversationId)}/${encodeURIComponent(activity.id)}`, {
    type: 'message',
    text: text.replace(/```chart[\s\S]*?```/g, '_(chart available in Corpus)_').slice(0, 25_000),
    textFormat: 'markdown',
    replyToId: activity.id,
  })
}
