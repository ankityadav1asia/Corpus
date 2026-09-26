import { setSessionCookie } from '@/server/auth/current-user'
import { startDemo } from '@/server/auth/demo'
import { clientIp } from '@/server/http/client-ip'
import { json, publicRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/**
 * Enters the public demo: a new guest account, a Viewer of the demo workspace, signed in with the
 * usual session cookie. 404 when no demo is configured; limited per IP.
 */
export const POST = publicRoute(async ({ req }) => {
  const { user, token } = await startDemo(getServices().repos, { ip: clientIp(req), userAgent: req.headers.get('user-agent')?.slice(0, 300) ?? null })
  const res = json({ user }, { status: 201 })
  setSessionCookie(res, token)
  return res
})
