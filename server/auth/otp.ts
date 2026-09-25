import 'server-only'

import { createHmac, randomInt } from 'node:crypto'

import type { EmailSender } from '@/server/email/sender'
import { isEmailAllowed } from '@/server/auth/login'
import { Errors } from '@/server/http/errors'
import { log } from '@/server/logger'
import type { Repositories } from '@/server/repositories'
import { secretsEqual } from '@/server/security/compare'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'

export const OTP_TTL_SECONDS = 10 * 60
export const OTP_MAX_ATTEMPTS = 5

export interface OtpDeps {
  repos: Pick<Repositories, 'otp' | 'rateLimits'>
  email: EmailSender | null
  secret: string
  isProduction: boolean
}

/** CSPRNG, uniformly distributed 6-digit code (Math.random was used before). */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

export function hashOtp(secret: string, email: string, code: string): string {
  return createHmac('sha256', secret).update(`otp:${email}:${code}`).digest('hex')
}

/**
 * Always answers the same way whether or not the email is allowed, so the endpoint cannot be
 * used to discover which addresses have access.
 */
export async function requestOtp(deps: OtpDeps, input: { email: string; ip: string }): Promise<void> {
  await enforceRateLimit(deps.repos, `otp-send:ip:${input.ip}`, RATE_LIMITS.otpSendPerIp)
  await enforceRateLimit(deps.repos, `otp-send:email:${input.email}`, RATE_LIMITS.otpSendPerEmail)
  if (!isEmailAllowed(input.email)) return

  const code = generateOtpCode()
  await deps.repos.otp.save(input.email, hashOtp(deps.secret, input.email, code), OTP_TTL_SECONDS)

  if (!deps.email) {
    if (deps.isProduction) throw Errors.notConfigured('Email sign-in is not configured on this server.')
    // Development convenience: the code goes to the server console only — never to the HTTP response.
    log.warn('No email provider configured; development sign-in code follows', { email: input.email, code })
    return
  }
  try {
    await deps.email.sendOtp(input.email, code, OTP_TTL_SECONDS / 60)
  } catch (error) {
    log.error('Sending the sign-in email failed', error)
    throw Errors.upstream('We could not send the email. Please try again.')
  }
}

/**
 * One answer for every failure (wrong, expired, used up, or never sent because the address is not
 * allowed), so the endpoint reveals nothing about which addresses can sign in.
 */
const INVALID_CODE = 'That code is incorrect or has expired. Check the latest email or request a new code.'

export async function verifyOtp(deps: OtpDeps, input: { email: string; code: string; ip: string }): Promise<void> {
  await enforceRateLimit(deps.repos, `otp-verify:ip:${input.ip}`, RATE_LIMITS.otpVerifyPerIp)
  // Per address and per day, across resends (each new code resets its own attempt counter).
  await enforceRateLimit(deps.repos, `otp-verify:email:${input.email}`, RATE_LIMITS.otpVerifyPerEmail)
  const invalid = Errors.badRequest(INVALID_CODE)

  // Counting the attempt and reading the hash is one atomic UPDATE, so parallel guesses
  // cannot exceed OTP_MAX_ATTEMPTS.
  const record = await deps.repos.otp.registerAttempt(input.email, OTP_MAX_ATTEMPTS)
  if (!record) throw invalid
  if (!secretsEqual(Buffer.from(record.codeHash, 'hex'), Buffer.from(hashOtp(deps.secret, input.email, input.code), 'hex'))) throw invalid
  // Single use: only one concurrent request can delete the row.
  if (!(await deps.repos.otp.consume(input.email, record.codeHash))) throw invalid
  if (Math.random() < 0.05) deps.repos.otp.purgeExpired().catch(() => undefined)
}
