import 'server-only'

import type { SessionUser } from '@/lib/contracts'
import { GUEST_EMAIL_DOMAIN, GUEST_LIFETIME_HOURS, newGuestEmail } from '@/server/auth/guest'
import { startSession } from '@/server/auth/login'
import { getDemoConfig, type DemoConfig } from '@/server/env'
import { Errors } from '@/server/http/errors'
import { log } from '@/server/logger'
import type { Repositories } from '@/server/repositories'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'

/**
 * The public demo: a visitor clicks "Enter the demo" and gets a short-lived guest account that is a
 * Viewer of one team workspace (DEMO_WORKSPACE_ID). Guests only look around and ask questions
 * (server/auth/permissions.ts → guestCan); their chats are private and removed with the account
 * after GUEST_LIFETIME_HOURS. Starts and questions are limited per IP and per day, so the demo
 * cannot use up the model quota.
 */

type DemoRepos = Pick<Repositories, 'users' | 'workspaces' | 'sessions' | 'rateLimits'>

export function demoConfigOrNotFound(): DemoConfig {
  const config = getDemoConfig()
  if (!config) throw Errors.notFound('Demo')
  return config
}

/** Removes demo visitors older than their lifetime (with their chats and sessions). */
export function purgeGuests(repos: Pick<Repositories, 'users'>): Promise<number> {
  return repos.users.deleteByDomainOlderThan(GUEST_EMAIL_DOMAIN, GUEST_LIFETIME_HOURS)
}

export async function startDemo(repos: DemoRepos, visitor: { ip: string; userAgent: string | null }): Promise<{ user: SessionUser; token: string }> {
  const config = demoConfigOrNotFound()
  await enforceRateLimit(repos, `demo:start:ip:${visitor.ip}`, RATE_LIMITS.demoStartPerIp)
  // Many addresses together still cannot fill the database with guest accounts.
  await enforceRateLimit(repos, 'demo:start:day', RATE_LIMITS.demoStartsPerDay)
  if (!(await repos.workspaces.isTeam(config.workspaceId))) {
    // A personal workspace would show its owner's private notebooks to every visitor.
    log.error('DEMO_WORKSPACE_ID does not name a team workspace; the demo stays closed', undefined, { workspaceId: config.workspaceId })
    throw Errors.notFound('Demo')
  }
  await purgeGuests(repos).catch((error) => log.warn('Could not remove old demo visitors', { error: String(error) }))
  const { user } = await repos.users.upsertOnLogin(newGuestEmail(), 'Demo visitor')
  await repos.workspaces.addMember(config.workspaceId, user.id, 'viewer')
  const token = await startSession(repos, user, visitor.userAgent)
  return { user: { ...user, guest: true }, token }
}
