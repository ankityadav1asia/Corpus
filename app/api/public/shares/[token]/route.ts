import { clientIp } from '@/server/http/client-ip'
import { Errors } from '@/server/http/errors'
import { json, publicRoute } from '@/server/http/route'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'
import { openShare } from '@/server/shares/service'

/** Content behind a public share link (no session needed). Unknown, revoked or orphaned links are 404. */
export const GET = publicRoute<{ token: string }>(async ({ req, params }) => {
  const { repos } = getServices()
  await enforceRateLimit(repos, `shared:ip:${clientIp(req)}`, RATE_LIMITS.sharedViews)
  const view = await openShare(repos, params.token)
  if (!view) throw Errors.notFound('Shared page')
  return json({ share: view }, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' } })
})
