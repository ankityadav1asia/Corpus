import { acceptedKeys, currentKey, type SecretKeys } from '@/server/security/keys'

/**
 * Signed session tokens (HMAC-SHA256 via Web Crypto). Each token names a server-side session
 * (`sid`, table app.sessions): middleware checks only the signature and expiry (edge, no
 * database), and every handler also checks that the session has not been revoked
 * (server/auth/current-user.ts), so signing out really ends a session.
 *
 * Edge-safe on purpose: middleware imports this file, so it must not import Node built-ins,
 * `server-only`, env helpers or anything that touches the database. The secret is passed in.
 */

export const SESSION_COOKIE = 'corpus_session'
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

export interface SessionClaims {
  v: 2
  /** Server-side session id (app.sessions). */
  sid: string
  sub: string
  email: string
  name: string | null
  iat: number
  exp: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const keyCache = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    keyCache.set(secret, key)
  }
  return key
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** Signs any JSON payload as `<base64url(json)>.<base64url(hmac)>` with the current key. */
export async function signToken(payload: object, secret: SecretKeys): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)))
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(currentKey(secret)), encoder.encode(body)))
  return `${body}.${base64UrlEncode(signature)}`
}

/**
 * Returns the payload only if the signature is valid for one of the accepted keys (the current
 * one, or the previous one during a rotation). `crypto.subtle.verify` compares in constant time.
 */
export async function verifyToken(token: string, secret: SecretKeys): Promise<unknown | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, signature] = parts as [string, string]
  const signatureBytes = base64UrlDecode(signature)
  if (!body || !signatureBytes || signatureBytes.length !== 32) return null
  let valid = false
  for (const key of acceptedKeys(secret)) {
    if (await crypto.subtle.verify('HMAC', await hmacKey(key), signatureBytes, encoder.encode(body))) {
      valid = true
      break
    }
  }
  if (!valid) return null
  const payloadBytes = base64UrlDecode(body)
  if (!payloadBytes) return null
  try {
    return JSON.parse(decoder.decode(payloadBytes)) as unknown
  } catch {
    return null
  }
}

function isSessionClaims(value: unknown): value is SessionClaims {
  if (!value || typeof value !== 'object') return false
  const claims = value as Record<string, unknown>
  return (
    claims.v === 2 &&
    typeof claims.sid === 'string' &&
    claims.sid.length > 0 &&
    typeof claims.sub === 'string' &&
    typeof claims.email === 'string' &&
    (claims.name === null || typeof claims.name === 'string') &&
    typeof claims.iat === 'number' &&
    typeof claims.exp === 'number'
  )
}

/** A token for an existing server-side session (see server/auth/login.ts, which creates both). */
export async function createSessionToken(
  session: { id: string; user: { id: string; email: string; name: string | null } },
  secret: SecretKeys,
  nowMs = Date.now(),
): Promise<string> {
  const iat = Math.floor(nowMs / 1000)
  const claims: SessionClaims = { v: 2, sid: session.id, sub: session.user.id, email: session.user.email, name: session.user.name, iat, exp: iat + SESSION_TTL_SECONDS }
  return signToken(claims, secret)
}

/** Signature, format and expiry only; whether the session was revoked is checked server-side. */
export async function readSessionToken(token: string, secret: SecretKeys, nowMs = Date.now()): Promise<SessionClaims | null> {
  const payload = await verifyToken(token, secret)
  if (!isSessionClaims(payload)) return null
  if (payload.exp * 1000 <= nowMs || payload.iat * 1000 > nowMs + 60_000) return null
  return payload
}
