import { SENTRY_OPTIONS, SENTRY_TUNNEL } from '@/lib/sentry'

/**
 * Browser error tracking, when NEXT_PUBLIC_SENTRY_DSN is set at build time. The SDK is loaded only
 * then, and it reports through this app's own /api/monitoring, so the Content-Security-Policy keeps
 * background requests to this origin.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  void import('@sentry/nextjs').then((Sentry) =>
    Sentry.init({ ...SENTRY_OPTIONS, dsn, tunnel: SENTRY_TUNNEL, environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV }),
  )
}
