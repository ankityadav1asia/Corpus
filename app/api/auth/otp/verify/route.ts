import { otpVerifySchema } from '@/lib/contracts'
import { setSessionCookie } from '@/server/auth/current-user'
import { completeLogin } from '@/server/auth/login'
import { verifyOtp } from '@/server/auth/otp'
import { getCoreEnv, isProduction } from '@/server/env'
import { readJson } from '@/server/http/body'
import { clientIp } from '@/server/http/client-ip'
import { json, publicRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

export const POST = publicRoute(async ({ req }) => {
  const { email, code } = await readJson(req, otpVerifySchema, 4 * 1024)
  const services = getServices()
  await verifyOtp({ repos: services.repos, email: null, secret: getCoreEnv().AUTH_SECRET, isProduction: isProduction() }, { email, code, ip: clientIp(req) })
  const { user, token } = await completeLogin(services.repos, { email, name: null }, req.headers.get('user-agent'))
  const res = json({ user })
  setSessionCookie(res, token)
  return res
})
