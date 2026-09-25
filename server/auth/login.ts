import 'server-only'

import type { SessionUser } from '@/lib/contracts'
import { SESSION_TTL_SECONDS, createSessionToken } from '@/server/auth/session'
import { getAuthPolicy, getSecretKeys, type AuthPolicy } from '@/server/env'
import { Errors } from '@/server/http/errors'
import type { Repositories } from '@/server/repositories'

/**
 * Empty allowlists = open sign-up. The allowlist is authoritative: a workspace invitation does not
 * let an address in that the allowlist rejects.
 */
export function isEmailAllowed(email: string, policy: AuthPolicy = getAuthPolicy()): boolean {
  if (policy.emails.size === 0 && policy.domains.size === 0) return true
  const normalized = email.trim().toLowerCase()
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1)
  return policy.emails.has(normalized) || policy.domains.has(domain)
}

/** Starts a server-side session for a user and returns its signed token. */
export async function startSession(repos: Pick<Repositories, 'sessions'>, user: SessionUser, userAgent: string | null = null, nowMs = Date.now()): Promise<string> {
  await repos.sessions.purgeExpired(user.id)
  const session = await repos.sessions.create({ userId: user.id, expiresAt: new Date(nowMs + SESSION_TTL_SECONDS * 1000), userAgent })
  return createSessionToken({ id: session.id, user }, getSecretKeys(), nowMs)
}

/**
 * Shared last step of every sign-in method:
 * allowlist → upsert user → accept pending invitations → personal workspace + notebook → session.
 */
export async function completeLogin(
  repos: Pick<Repositories, 'users' | 'workspaces' | 'collections' | 'sessions'>,
  identity: { email: string; name: string | null },
  userAgent: string | null = null,
): Promise<{ user: SessionUser; token: string }> {
  if (!isEmailAllowed(identity.email)) throw Errors.forbidden('This account is not allowed to sign in.')
  const { user } = await repos.users.upsertOnLogin(identity.email, identity.name)
  await repos.workspaces.acceptInvites(user.id, user.email)
  const personalWorkspaceId = await repos.workspaces.ensurePersonal(user.id)
  await repos.collections.ensureDefault(personalWorkspaceId, user.id)
  const token = await startSession(repos, user, userAgent)
  return { user, token }
}
