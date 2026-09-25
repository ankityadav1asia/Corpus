import { NextResponse, type NextRequest } from 'next/server'

import { isPublicPath } from '@/server/auth/public-paths'
import { SESSION_COOKIE, readSessionToken } from '@/server/auth/session'
import { contentSecurityPolicy, createNonce } from '@/server/security/csp'
import type { SecretKeys } from '@/server/security/keys'

const MIN_SECRET_LENGTH = 32

/** AUTH_SECRET, plus AUTH_SECRET_PREVIOUS while rotating (see server/env.ts → getSecretKeys). */
function secretKeys(): SecretKeys | null {
  const current = process.env.AUTH_SECRET
  if (!current || current.length < MIN_SECRET_LENGTH) return null
  const previous = process.env.AUTH_SECRET_PREVIOUS
  return previous && previous.length >= MIN_SECRET_LENGTH && previous !== current ? [current, previous] : [current]
}

/**
 * Edge check of signature and expiry only (no database here). Handlers additionally verify that
 * the session was not revoked (server/auth/current-user.ts).
 */
async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const keys = secretKeys()
  if (!token || !keys) return false
  return (await readSessionToken(token, keys)) !== null
}

/** Lets the request through with a per-request CSP nonce (read by app/layout.tsx and Next.js). */
function next(req: NextRequest): NextResponse {
  const nonce = createNonce()
  const policy = contentSecurityPolicy(nonce, { development: process.env.NODE_ENV !== 'production' })
  const headers = new Headers(req.headers)
  headers.set('x-nonce', nonce)
  headers.set('content-security-policy', policy)
  const res = NextResponse.next({ request: { headers } })
  res.headers.set('Content-Security-Policy', policy)
  return res
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl
  if (isPublicPath(pathname) || (await hasValidSession(req))) return next(req)

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in to continue.' } }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }
  const login = new URL('/login', req.url)
  if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`)
  return NextResponse.redirect(login)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|pdf.min.mjs|pdf.worker.min.mjs).*)'],
}
