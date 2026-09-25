import { otpSendSchema } from '@/lib/contracts'
import { requestOtp } from '@/server/auth/otp'
import { getCoreEnv, isProduction } from '@/server/env'
import { readJson } from '@/server/http/body'
import { clientIp } from '@/server/http/client-ip'
import { json, publicRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

export const POST = publicRoute(async ({ req }) => {
  const { email } = await readJson(req, otpSendSchema, 4 * 1024)
  const services = getServices()
  await requestOtp({ repos: services.repos, email: services.email(), secret: getCoreEnv().AUTH_SECRET, isProduction: isProduction() }, { email, ip: clientIp(req) })
  // Same answer for every address so the endpoint cannot be used to probe the allowlist.
  return json({ ok: true, message: 'If this address can sign in, a 6-digit code is on its way.' })
})
