import type { Instrumentation } from 'next'

/**
 * Runs once when a server instance starts. In production it refuses to start with a missing or
 * unsafe configuration (server/config-check.ts), so a bad deploy fails its health check with a
 * clear log line instead of failing on the first request. With a Sentry DSN, errors the server logs
 * (unhandled route errors, failed background jobs) are also reported there.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { assertConfig } = await import('@/server/config-check')
  assertConfig('web server')

  const { getSentryConfig } = await import('@/server/env')
  const sentry = getSentryConfig()
  if (!sentry) return
  const [Sentry, { setErrorReporter }, { SENTRY_OPTIONS }] = await Promise.all([import('@sentry/nextjs'), import('@/server/logger'), import('@/lib/sentry')])
  Sentry.init({ ...SENTRY_OPTIONS, dsn: sentry.dsn, environment: sentry.environment, release: sentry.release ?? undefined })
  setErrorReporter((error, message, fields) => {
    Sentry.captureException(error, { extra: { message, ...fields } })
  })
}

/** Errors Next.js itself catches (pages, server components); route handlers report through the logger. */
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { getSentryConfig } = await import('@/server/env')
  if (!getSentryConfig()) return
  const Sentry = await import('@sentry/nextjs')
  Sentry.captureRequestError(...args)
}
