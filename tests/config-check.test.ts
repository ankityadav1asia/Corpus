import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { assertConfig, checkConfig } from '@/server/config-check'
import { getAppOrigin, getConfiguredAppUrl, resetEnvCache, trustedProxyHops, webRunsJobs } from '@/server/env'

const KEYS = [
  'NODE_ENV',
  'POSTGRES_URL',
  'AUTH_SECRET',
  'AUTH_SECRET_PREVIOUS',
  'APP_URL',
  'TRUST_PROXY',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_BRANCH_URL',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'WEB_RUNS_JOBS',
  'CRON_SECRET',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'CHAT_PROVIDER',
  'EMBEDDING_PROVIDER',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'RESEND_API_KEY',
  'SMTP_USER',
  'SMTP_PASS',
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
] as const

const env = process.env as Record<string, string | undefined>
const saved = Object.fromEntries(KEYS.map((key) => [key, env[key]]))

/** A complete production configuration; each test changes only what it is about. */
const PRODUCTION = {
  NODE_ENV: 'production',
  POSTGRES_URL: 'postgres://corpus:password@db.example.com/corpus',
  AUTH_SECRET: 'a'.repeat(48),
  APP_URL: 'https://corpus.example.com',
  TRUST_PROXY: '1',
  GOOGLE_API_KEY: 'AIza-test-key-0123456789abcdef',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
}

function setEnv(vars: Record<string, string | undefined>) {
  for (const key of KEYS) delete env[key]
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) env[key] = value
  resetEnvCache()
}

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key]
    else env[key] = saved[key]
  }
  resetEnvCache()
})

describe('startup configuration check', () => {
  it('accepts a complete production configuration', () => {
    setEnv(PRODUCTION)
    assert.deepEqual(checkConfig(), { errors: [], warnings: [] })
  })

  it('refuses to start production without what it needs', (t) => {
    setEnv({ ...PRODUCTION, AUTH_SECRET: 'too-short', APP_URL: undefined })
    const missing = checkConfig().errors
    assert.equal(missing.length, 2)
    assert.match(missing[0]!, /AUTH_SECRET \(min 32 chars\)/)
    assert.match(missing[1]!, /APP_URL is required/)

    setEnv({ ...PRODUCTION, POSTGRES_URL: 'pglite:./.data/prod', APP_URL: 'http://corpus.example.com' })
    const unsafe = checkConfig().errors
    assert.equal(unsafe.length, 2)
    assert.match(unsafe[0]!, /PGlite/)
    assert.match(unsafe[1]!, /must start with https:\/\//)

    t.mock.method(console, 'error', () => undefined)
    t.mock.method(console, 'warn', () => undefined)
    assert.throws(() => assertConfig('web server'), /Refusing to start web server: 2 configuration error/)
  })

  it('warns about settings that only turn a feature off', () => {
    setEnv({ ...PRODUCTION, AUTH_SECRET_PREVIOUS: 'b'.repeat(48), TRUST_PROXY: undefined, GOOGLE_API_KEY: undefined, GOOGLE_CLIENT_ID: undefined })
    const { errors, warnings } = checkConfig()
    assert.deepEqual(errors, [])
    assert.equal(warnings.length, 4)
    assert.match(warnings.join('\n'), /AUTH_SECRET_PREVIOUS is set/)
    assert.match(warnings.join('\n'), /TRUST_PROXY is not set/)
    assert.match(warnings.join('\n'), /No AI model is configured/)
    assert.match(warnings.join('\n'), /No sign-in method is configured/)
  })

  it('only warns in development', (t) => {
    setEnv({ NODE_ENV: 'development', POSTGRES_URL: 'pglite:./.data/dev', AUTH_SECRET: 'a'.repeat(48) })
    assert.deepEqual(checkConfig().errors, [])
    t.mock.method(console, 'warn', () => undefined)
    assert.doesNotThrow(() => assertConfig('web server'))
  })
})

describe('on Vercel', () => {
  /** What Vercel sets on a production deployment; APP_URL and TRUST_PROXY are left out on purpose. */
  const VERCEL_PRODUCTION = {
    ...PRODUCTION,
    APP_URL: undefined,
    TRUST_PROXY: undefined,
    VERCEL: '1',
    VERCEL_ENV: 'production',
    VERCEL_URL: 'corpus-abc123-ankit.vercel.app',
    VERCEL_BRANCH_URL: 'corpus-git-main-ankit.vercel.app',
    VERCEL_PROJECT_PRODUCTION_URL: 'corpus.vercel.app',
    CRON_SECRET: 'c'.repeat(32),
  }

  it("starts without APP_URL: the deployment's own https address is the public origin", () => {
    setEnv(VERCEL_PRODUCTION)
    assert.deepEqual(checkConfig(), { errors: [], warnings: [] })
    assert.equal(getConfiguredAppUrl(), 'https://corpus.vercel.app')
    assert.equal(getAppOrigin('https://spoofed.example/api/auth/oauth/start'), 'https://corpus.vercel.app', 'the Host header never decides it')

    setEnv({ ...VERCEL_PRODUCTION, VERCEL_ENV: 'preview' })
    assert.equal(getConfiguredAppUrl(), 'https://corpus-git-main-ankit.vercel.app', 'previews use their branch address')
    setEnv({ ...VERCEL_PRODUCTION, APP_URL: 'https://docs.example.com' })
    assert.equal(getConfiguredAppUrl(), 'https://docs.example.com', 'APP_URL (a custom domain) wins')
    setEnv({ ...PRODUCTION, APP_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: 'corpus.vercel.app' })
    assert.equal(getConfiguredAppUrl(), null, 'only on Vercel')
  })

  it('warns when the cron cannot drain the job queue', () => {
    setEnv({ ...VERCEL_PRODUCTION, CRON_SECRET: undefined })
    assert.match(checkConfig().warnings.join('\n'), /CRON_SECRET is not set/)
    setEnv({ ...VERCEL_PRODUCTION, CRON_SECRET: undefined, WEB_RUNS_JOBS: 'false' })
    assert.deepEqual(checkConfig().warnings, [], 'a separate worker drains it')
  })
})

describe('deployment switches', () => {
  it('lets a dedicated worker take the job queue off the web server', () => {
    const runs = (value?: string) => {
      setEnv({ WEB_RUNS_JOBS: value })
      return webRunsJobs()
    }
    assert.equal(runs(), true, 'on by default (single process, serverless)')
    assert.equal(runs('true'), true)
    assert.equal(runs('false'), false)
    assert.equal(runs('0'), false)
    assert.equal(runs('OFF'), false)
  })
})

describe('trusted proxies', () => {
  it('reads TRUST_PROXY as a number of proxy hops', () => {
    const hops = (vars: Record<string, string>) => {
      setEnv(vars)
      return trustedProxyHops()
    }
    assert.equal(hops({}), 0)
    assert.equal(hops({ TRUST_PROXY: 'true' }), 1)
    assert.equal(hops({ TRUST_PROXY: '1' }), 1)
    assert.equal(hops({ TRUST_PROXY: '2' }), 2)
    assert.equal(hops({ TRUST_PROXY: '50' }), 5, 'capped')
    assert.equal(hops({ TRUST_PROXY: '0' }), 0)
    assert.equal(hops({ TRUST_PROXY: 'false' }), 0)
    assert.equal(hops({ TRUST_PROXY: '1.5' }), 0)
    assert.equal(hops({ VERCEL: '1' }), 1)
  })
})
