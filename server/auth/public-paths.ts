/**
 * Exact-match allowlist of routes reachable without a session. Everything else requires one
 * (fail closed). The previous middleware listed '/' with a prefix rule, which made *every* path
 * public. Route handlers re-check the session themselves, so this is defence in depth.
 * Edge-safe: imported by middleware.
 */
const PUBLIC_PATHS = new Set([
  '/login',
  '/api/health',
  '/api/auth',
  '/api/auth/otp/send',
  '/api/auth/otp/verify',
  '/api/auth/oauth/google',
  '/api/auth/oauth/github',
  '/api/auth/oauth/callback',
  // Authenticated by a bearer CRON_SECRET inside the handler (404 when not configured).
  '/api/jobs/run',
])

/**
 * Prefixes whose routes authenticate without a session: shared pages (a secret token in the path),
 * and chat-app webhooks (Slack request signatures, Bot Framework JWTs — checked in the handler).
 * Each segment after the prefix must be a single path component, so `/s/../api/…` never matches.
 */
const PUBLIC_PREFIXES = [/^\/s\/[A-Za-z0-9_-]+$/, /^\/api\/public\/shares\/[A-Za-z0-9_-]+$/, /^\/api\/integrations\/(slack|teams)\/[0-9a-f-]{36}\/(events|messages)$/]

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((pattern) => pattern.test(pathname))
}
