import { getSentryConfig } from '@/server/env'
import { readBodyBytes } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { publicRoute } from '@/server/http/route'
import { log } from '@/server/logger'
import { envelopeUrl } from '@/server/monitoring'

/** Browser error reports are small; a large body is not one. */
const MAX_BYTES = 256 * 1024

/**
 * Sentry's browser SDK sends its reports here (the `tunnel` option, instrumentation-client.ts), so the
 * Content-Security-Policy can keep background requests to this origin. Only envelopes for the
 * configured project are forwarded: this is not an open relay. 404 when error tracking is off.
 */
export const POST = publicRoute(async ({ req }) => {
  const dsn = getSentryConfig()?.browserDsn
  const target = dsn ? envelopeUrl(dsn) : null
  if (!dsn || !target) throw Errors.notFound('Endpoint')
  const body = await readBodyBytes(req, MAX_BYTES)
  const text = new TextDecoder().decode(body)
  let header: { dsn?: unknown }
  try {
    header = JSON.parse(text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'))) as { dsn?: unknown }
  } catch {
    throw Errors.badRequest('Not an error report.')
  }
  if (header.dsn !== dsn) throw Errors.badRequest('Not an error report for this app.')
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body,
      signal: AbortSignal.timeout(5000),
    })
    return new Response(null, { status: upstream.ok ? 200 : 502 })
  } catch (error) {
    log.warn('Could not forward an error report', { error: String(error) })
    return new Response(null, { status: 502 })
  }
})
