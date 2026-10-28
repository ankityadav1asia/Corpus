import type { init } from '@sentry/nextjs'

/**
 * Sentry options shared by the browser and the server. The SDK collects request data by default;
 * here everything that can carry personal data or secrets is switched off: users, cookies, headers,
 * bodies, query strings, local variables in stack frames, model inputs and outputs, SQL.
 */
export const SENTRY_OPTIONS: Pick<NonNullable<Parameters<typeof init>[0]>, 'tracesSampleRate' | 'dataCollection'> = {
  tracesSampleRate: 0,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
  },
}

/** Where the browser SDK sends reports: this app, which forwards them (app/api/monitoring). */
export const SENTRY_TUNNEL = '/api/monitoring'
