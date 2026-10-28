import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as monitoringRoute from '@/app/api/monitoring/route'
import { resetEnvCache } from '@/server/env'
import { log, setErrorReporter } from '@/server/logger'
import { envelopeUrl } from '@/server/monitoring'

const DSN = 'https://public123@o1.ingest.sentry.io/4507'
const realFetch = globalThis.fetch

function report(body: string, origin = 'http://localhost:3000') {
  const req = new NextRequest('http://localhost:3000/api/monitoring', { method: 'POST', body, headers: { host: 'localhost:3000', origin, 'content-type': 'text/plain' } })
  return monitoringRoute.POST(req, { params: Promise.resolve({}) })
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SENTRY_DSN
  resetEnvCache()
  globalThis.fetch = realFetch
  setErrorReporter(null)
})

describe('error reporting', () => {
  it('finds the envelope endpoint of a DSN, with or without a path prefix', () => {
    assert.equal(envelopeUrl(DSN), 'https://o1.ingest.sentry.io/api/4507/envelope/')
    assert.equal(envelopeUrl('https://key@sentry.example.com/errors/12'), 'https://sentry.example.com/errors/api/12/envelope/')
    assert.equal(envelopeUrl('not a dsn'), null)
    assert.equal(envelopeUrl('ftp://key@host/1'), null)
  })

  it('forwards browser reports to the configured project only, and is off without a DSN', async () => {
    assert.equal((await report('{}\n{}')).status, 404)

    process.env.NEXT_PUBLIC_SENTRY_DSN = DSN
    resetEnvCache()
    const forwarded: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      forwarded.push(String(url))
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const envelope = `${JSON.stringify({ dsn: DSN, sent_at: '2026-10-28T00:00:00Z' })}\n{"type":"event"}\n{"message":"boom"}`
    assert.equal((await report(envelope)).status, 200)
    assert.deepEqual(forwarded, ['https://o1.ingest.sentry.io/api/4507/envelope/'])

    // Another project, a malformed body, another site: refused, nothing forwarded.
    assert.equal((await report(`${JSON.stringify({ dsn: 'https://k@attacker.example/1' })}\n{}`)).status, 400)
    assert.equal((await report('not json')).status, 400)
    assert.equal((await report(envelope, 'https://evil.example')).status, 403)
    assert.equal(forwarded.length, 1)
  })

  it('sends logged errors to the reporter without breaking the caller when it fails', () => {
    const seen: string[] = []
    setErrorReporter((error, message, fields) => seen.push(`${message}: ${String(error)} ${JSON.stringify(fields)}`))
    log.error('Background job failed', new Error('quota'), { jobId: 'j1' })
    log.error('Just a message')
    assert.deepEqual(seen, ['Background job failed: Error: quota {"jobId":"j1"}'])

    setErrorReporter(() => {
      throw new Error('reporter down')
    })
    assert.doesNotThrow(() => log.error('Still logged', new Error('x')))
  })
})
