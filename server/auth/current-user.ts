import 'server-only'

import { cookies } from 'next/headers'
import type { NextRequest, NextResponse } from 'next/server'

import type { SessionUser } from '@/lib/contracts'
import { isGuestEmail } from '@/server/auth/guest'
import { SESSION_COOKIE, SESSION_TTL_SECONDS, readSessionToken, type SessionClaims } from '@/server/auth/session'
import { getSecretKeys, shouldUseSecureCookies } from '@/server/env'
import { getServices } from '@/server/services'

/**
 * Sessions confirmed active recently, so every request does not cost a database round trip.
 * Revoking on this instance forgets the entry at once; other instances notice within the TTL.
 */
const ACTIVE_CACHE_TTL_MS = 30_000
const ACTIVE_CACHE_MAX = 5_000
const activeSessions = new Map<string, number>()

async function isSessionActive(claims: SessionClaims): Promise<boolean> {
  const key = `${claims.sid}:${claims.sub}`
  const cachedUntil = activeSessions.get(key)
  if (cachedUntil !== undefined && cachedUntil > Date.now()) return true
  const active = await getServices().repos.sessions.isActive(claims.sid, claims.sub)
  if (active) {
    if (activeSessions.size >= ACTIVE_CACHE_MAX) activeSessions.clear()
    activeSessions.set(key, Date.now() + ACTIVE_CACHE_TTL_MS)
  } else {
    activeSessions.delete(key)
  }
  return active
}

/** Forgets cached "active" results (after revoking), for one session or for all of a user's. */
function forgetSessions(match: (key: string) => boolean) {
  for (const key of activeSessions.keys()) if (match(key)) activeSessions.delete(key)
}

async function readClaims(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null
  return readSessionToken(token, getSecretKeys())
}

async function toUser(token: string | undefined): Promise<SessionUser | null> {
  const claims = await readClaims(token)
  if (!claims || !(await isSessionActive(claims))) return null
  return { id: claims.sub, email: claims.email, name: claims.name, ...(isGuestEmail(claims.email) ? { guest: true } : {}) }
}

/** For server components (uses the request-scoped cookie store). */
export async function getUserFromCookies(): Promise<SessionUser | null> {
  const store = await cookies()
  return toUser(store.get(SESSION_COOKIE)?.value)
}

/** For route handlers. */
export function getUserFromRequest(req: NextRequest): Promise<SessionUser | null> {
  return toUser(req.cookies.get(SESSION_COOKIE)?.value)
}

/**
 * Ends the session behind the request's cookie (sign out), or every session of its user
 * (`everywhere`, e.g. after a lost device). Tolerates missing, expired or foreign tokens.
 */
export async function endSession(req: NextRequest, options: { everywhere?: boolean } = {}): Promise<void> {
  const claims = await readClaims(req.cookies.get(SESSION_COOKIE)?.value)
  if (!claims) return
  const { sessions } = getServices().repos
  if (options.everywhere) {
    await sessions.revokeAll(claims.sub)
    forgetSessions((key) => key.endsWith(`:${claims.sub}`))
  } else {
    await sessions.revoke(claims.sid, claims.sub)
    forgetSessions((key) => key === `${claims.sid}:${claims.sub}`)
  }
}

/** Tests reset the cache between scenarios. */
export function clearSessionCacheForTests() {
  activeSessions.clear()
}

export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}
