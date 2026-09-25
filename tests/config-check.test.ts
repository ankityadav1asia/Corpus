import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { assertConfig, checkConfig } from '@/server/config-check'
import { resetEnvCache, trustedProxyHops, webRunsJobs } from '@/server/env'

const KEYS = [
  'NODE_ENV',
  'POSTGRES_URL',
  'AUTH_SECRET',
  'AUTH_SECRET_PREVIOUS',
  'APP_URL',
  'TRUST_PROXY',
  'VERCEL',
  'WEB_RUNS_JOBS',
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
