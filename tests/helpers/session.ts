import type { SessionUser } from '@/lib/contracts'
import { SESSION_TTL_SECONDS, createSessionToken } from '@/server/auth/session'
import type { Repositories } from '@/server/repositories'

/** A signed session token backed by a real (active) session row, as sign-in creates them. */
export async function sessionToken(repos: Pick<Repositories, 'sessions'>, user: SessionUser, secret: string): Promise<string> {
  const session = await repos.sessions.create({ userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000), userAgent: 'test' })
  return createSessionToken({ id: session.id, user }, secret)
}
