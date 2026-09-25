/** Field schemas shared by the request contracts (not part of the public contract). */
import { z } from 'zod'

import { ROLES } from '@/lib/constants'

export const id = z.guid()
export const requiredText = (max: number) => z.string().trim().min(1).max(max)
export const email = z.string().trim().toLowerCase().pipe(z.email().max(254))
export const role = z.enum(ROLES)
export const secretText = (max: number) => z.string().trim().min(1).max(max)
