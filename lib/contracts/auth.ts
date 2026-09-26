/** Signing in and the signed-in user. */
import { z } from 'zod'

import { email } from './fields'

export interface SessionUser {
  id: string
  email: string
  name: string | null
  /** A demo visitor: read-only access to the demo workspace (POST /api/auth/demo). */
  guest?: boolean
}

export const otpSendSchema = z.object({ email })
export const otpVerifySchema = z.object({
  email,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
})
