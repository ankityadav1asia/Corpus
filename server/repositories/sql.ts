import { EMBEDDING_DIMENSIONS } from '@/lib/constants'

/** Timestamps come back as Date (Neon, PGlite) or string depending on the driver. */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return new Date(value).toISOString()
  return new Date(0).toISOString()
}

export function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value)
}

/** pgvector text literal, passed as a bound parameter and cast with `$n::vector`. */
export function vectorLiteral(values: readonly number[]): string {
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Expected a ${EMBEDDING_DIMENSIONS}-dimension embedding, got ${values.length}`)
  }
  return `[${values.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`
}

/** Binary data is stored in bytea parts of at most this size: well under the per-request limits of serverless Postgres drivers. */
export const BYTE_PART_SIZE = 2 * 1024 * 1024

/** Bytes as base64, bound in SQL with `decode($n, 'base64')` (drivers differ in how they send bytea). */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** Splits bytes into base64 parts of at most BYTE_PART_SIZE bytes each, in order. */
export function base64Parts(bytes: Uint8Array, partSize = BYTE_PART_SIZE): string[] {
  const parts: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += partSize) parts.push(toBase64(bytes.subarray(offset, offset + partSize)))
  return parts
}

/** Reassembles rows selected in order as `encode(data, 'base64') AS data`. */
export function joinBase64Parts(rows: ReadonlyArray<Record<string, unknown>>): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.concat(rows.map((row) => Buffer.from(String(row.data), 'base64'))))
}

/** Parts read per query: 8 × 2 MB is about 22 MB of base64, far below Neon's 64 MB HTTP response limit. */
const PARTS_PER_QUERY = 8

/**
 * Reads stored bytes a few parts per query and reassembles them. A whole 50 MB file in one query
 * would be 67 MB of base64, more than a serverless driver returns. `select` returns the rows
 * `encode(data, 'base64') AS data` in order, with `LIMIT limit OFFSET offset`.
 */
export async function readPartsInBatches(select: (offset: number, limit: number) => Promise<ReadonlyArray<Record<string, unknown>>>): Promise<Uint8Array<ArrayBuffer>> {
  const rows: Array<Record<string, unknown>> = []
  for (let offset = 0; ; offset += PARTS_PER_QUERY) {
    const batch = await select(offset, PARTS_PER_QUERY)
    rows.push(...batch)
    if (batch.length < PARTS_PER_QUERY) return joinBase64Parts(rows)
  }
}

/** Escapes LIKE wildcards so user search text is matched literally (used with ESCAPE '\'). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export function asJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return []
}

/** uuid[] comes back as an array or as a Postgres array literal ({a,b}) depending on the driver. */
export function asUuidArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.startsWith('{')) return value.slice(1, -1).split(',').filter(Boolean)
  return []
}

export function asJsonObject<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }
  return value as T
}
