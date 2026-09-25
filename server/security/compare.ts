import { timingSafeEqual } from 'node:crypto'

/**
 * Compares two secrets (tokens, signatures, hashes) in constant time, so response timing does not
 * reveal how much of a guess was right. Different lengths are simply unequal.
 */
export function secretsEqual(a: string | Buffer, b: string | Buffer): boolean {
  const left = typeof a === 'string' ? Buffer.from(a) : a
  const right = typeof b === 'string' ? Buffer.from(b) : b
  return left.length === right.length && timingSafeEqual(left, right)
}
