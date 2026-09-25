import type { NextRequest } from 'next/server'
import type { ZodType } from 'zod'

import { Errors } from '@/server/http/errors'

const DEFAULT_JSON_LIMIT = 64 * 1024

export function parseWith<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw Errors.validation(result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })))
  }
  return result.data
}

/**
 * Reads the body with a hard byte cap. Checks Content-Length first, then counts bytes while
 * streaming, so chunked uploads without a length header cannot exhaust memory either.
 */
export async function readBodyBytes(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw Errors.payloadTooLarge(`Request body exceeds ${Math.round(maxBytes / 1024)} KB.`)
  }
  if (!req.body) return new Uint8Array(0)

  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw Errors.payloadTooLarge(`Request body exceeds ${Math.round(maxBytes / 1024)} KB.`)
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

export async function readJson<T>(req: Request, schema: ZodType<T>, maxBytes = DEFAULT_JSON_LIMIT): Promise<T> {
  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw Errors.unsupportedMediaType('Expected a JSON request body.')
  }
  const text = new TextDecoder().decode(await readBodyBytes(req, maxBytes))
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw Errors.badRequest('Malformed JSON body.')
  }
  return parseWith(schema, value)
}

export async function readFormData(req: Request, maxBytes: number): Promise<FormData> {
  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw Errors.unsupportedMediaType('Expected a multipart/form-data upload.')
  }
  const bytes = await readBodyBytes(req, maxBytes)
  try {
    return await new Response(bytes, { headers: { 'content-type': contentType } }).formData()
  } catch {
    throw Errors.badRequest('Malformed upload.')
  }
}

export function readSearchParams<T>(req: NextRequest, schema: ZodType<T>): T {
  const entries: Record<string, string> = {}
  req.nextUrl.searchParams.forEach((value, key) => {
    if (value !== '') entries[key] = value
  })
  return parseWith(schema, entries)
}
