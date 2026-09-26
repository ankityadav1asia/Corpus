import 'server-only'

import {
  getConfiguredAppUrl,
  getCoreEnv,
  getCronSecret,
  getEmailConfig,
  getOAuthClient,
  getSecretKeys,
  isAiConfigured,
  isProduction,
  isVercel,
  trustedProxyHops,
  webRunsJobs,
} from '@/server/env'
import { log } from '@/server/logger'
import { acceptedKeys } from '@/server/security/keys'

export interface ConfigReport {
  /** The server must not start with these. */
  errors: string[]
  /** It starts, but a feature will not work. */
  warnings: string[]
}

/**
 * Checks the configuration a production server needs, so a bad deploy fails at start with a clear
 * message instead of on the first request. Development only warns.
 */
export function checkConfig(): ConfigReport {
  const errors: string[] = []
  const warnings: string[] = []
  const production = isProduction()

  try {
    const core = getCoreEnv()
    if (production && core.POSTGRES_URL.startsWith('pglite:')) errors.push('POSTGRES_URL points at PGlite, which is for local development only. Use a Postgres server (e.g. Neon).')
    if (acceptedKeys(getSecretKeys()).length > 1) warnings.push('AUTH_SECRET_PREVIOUS is set: finish the rotation (npm run secrets:reseal) and remove it after 7 days.')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  if (production) {
    const appUrl = getConfiguredAppUrl()
    if (!appUrl) errors.push('APP_URL is required in production (the public https origin, e.g. https://corpus.example.com).')
    else if (!appUrl.startsWith('https://')) errors.push('APP_URL must start with https:// in production (secure cookies, OAuth and chat-app webhooks need it).')
    if (trustedProxyHops() === 0)
      warnings.push('TRUST_PROXY is not set: behind a proxy, per-IP rate limits cannot tell callers apart (set TRUST_PROXY=1 behind one reverse proxy).')
    if (isVercel() && webRunsJobs() && !getCronSecret())
      warnings.push('CRON_SECRET is not set: Vercel Cron cannot call /api/jobs/run, so queued work only moves while someone uses the app.')
  }

  if (!isAiConfigured()) warnings.push('No AI model is configured (GOOGLE_API_KEY or CHAT_PROVIDER=openai-compatible): chat and indexing are disabled.')
  const canSignIn = getEmailConfig() !== null || getOAuthClient('google') !== null || getOAuthClient('github') !== null
  if (production && !canSignIn) warnings.push('No sign-in method is configured (email provider, Google or GitHub OAuth): nobody can sign in.')

  return { errors, warnings }
}

/** Logs the report; throws in production when something required is missing. */
export function assertConfig(where: string): void {
  const { errors, warnings } = checkConfig()
  for (const warning of warnings) log.warn(`Configuration: ${warning}`, { where })
  if (errors.length === 0) return
  for (const error of errors) log.error(`Configuration: ${error}`, undefined, { where })
  if (isProduction()) throw new Error(`Refusing to start ${where}: ${errors.length} configuration error(s), see the log above.`)
}
