import { isIP } from 'node:net'

import { trustedProxyHops } from '@/server/env'

/**
 * Best-effort client IP for rate limiting.
 *
 * Forwarding headers are client-controlled unless a trusted proxy writes them, so they are only
 * honoured on Vercel or when TRUST_PROXY is set. Otherwise every caller shares one bucket and the
 * per-account / per-email limits do the real work. Each trusted proxy appends the address it
 * received the request from, so behind N proxies the client is the Nth X-Forwarded-For entry from
 * the end; anything before it is whatever the client sent.
 */
export function clientIp(req: Request): string {
  return clientIpFromHeaders(req.headers)
}

/** The same, from request headers (server components, where there is no Request object). */
export function clientIpFromHeaders(headers: Headers): string {
  const hops = trustedProxyHops()
  if (hops === 0) return 'untrusted'

  const chain = headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((entry) => entry.trim())
  if (chain) {
    const client = chain.length >= hops ? chain[chain.length - hops] : undefined
    return client && isIP(client) ? client : 'unknown'
  }
  // Proxies that set X-Real-IP instead of appending to X-Forwarded-For.
  const realIp = headers.get('x-real-ip')?.trim()
  return realIp && isIP(realIp) ? realIp : 'unknown'
}
