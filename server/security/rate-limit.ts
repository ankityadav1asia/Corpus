import { Errors } from '@/server/http/errors'
import { log } from '@/server/logger'
import type { Repositories } from '@/server/repositories'

export interface RateLimitRule {
  limit: number
  windowSeconds: number
}

export const RATE_LIMITS = {
  chat: { limit: 20, windowSeconds: 60 },
  ingest: { limit: 30, windowSeconds: 600 },
  chunkEdit: { limit: 120, windowSeconds: 600 },
  reports: { limit: 10, windowSeconds: 3600 },
  benchmarks: { limit: 5, windowSeconds: 3600 },
  invites: { limit: 30, windowSeconds: 3600 },
  images: { limit: 20, windowSeconds: 3600 },
  audio: { limit: 10, windowSeconds: 3600 },
  mindmaps: { limit: 30, windowSeconds: 3600 },
  connectorSync: { limit: 60, windowSeconds: 3600 },
  feedback: { limit: 300, windowSeconds: 3600 },
  followups: { limit: 200, windowSeconds: 3600 },
  shares: { limit: 60, windowSeconds: 3600 },
  sharedViews: { limit: 120, windowSeconds: 60 },
  botMessages: { limit: 120, windowSeconds: 3600 },
  otpSendPerEmail: { limit: 3, windowSeconds: 900 },
  otpSendPerIp: { limit: 20, windowSeconds: 900 },
  otpVerifyPerIp: { limit: 30, windowSeconds: 900 },
  otpVerifyPerEmail: { limit: 20, windowSeconds: 86_400 },
} satisfies Record<string, RateLimitRule>

/** Throws 429 when `key` exceeds `rule`. Backed by Postgres, so it holds across server instances. */
export async function enforceRateLimit(repos: Pick<Repositories, 'rateLimits'>, key: string, rule: RateLimitRule) {
  const { count, resetAt } = await repos.rateLimits.hit(key, rule.windowSeconds)
  if (Math.random() < 0.01) {
    repos.rateLimits.purgeStale().catch((error) => log.warn('Rate limit cleanup failed', { error: String(error) }))
  }
  if (count > rule.limit) {
    throw Errors.rateLimited(Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)))
  }
}
