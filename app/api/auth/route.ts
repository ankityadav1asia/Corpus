import { clearSessionCookie, endSession } from '@/server/auth/current-user'
import { authedRoute, json, publicRoute } from '@/server/http/route'

/** Current session user (401 when signed out). */
export const GET = authedRoute(async ({ user }) => json({ user }))

/**
 * Sign out: revokes this session server-side (the token stops working everywhere at once) and
 * clears the cookie. `?scope=all` signs out every device of the user. Public so an expired
 * session can still clear its cookie.
 */
export const DELETE = publicRoute(async ({ req }) => {
  await endSession(req, { everywhere: req.nextUrl.searchParams.get('scope') === 'all' })
  const res = json({ ok: true })
  clearSessionCookie(res)
  return res
})
