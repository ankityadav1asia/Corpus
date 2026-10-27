import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { GO_API_PATHS } from '../next.config.mjs'

/**
 * The Go backend (backend/) serves some API paths instead of Next.js. Three places must agree:
 * vercel.json routes them to the Go service, next.config.mjs proxies them to GO_API_URL in local
 * development, and no Next.js route file may still exist for them (it would never run on Vercel).
 */
describe('Go backend routing', () => {
  const vercel = JSON.parse(readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')) as {
    services: Record<string, { root: string }>
    rewrites: Array<{ source: string; destination: { service: string } }>
  }

  it('vercel.json sends exactly the Go paths to the Go service, before the Next.js catch-all', () => {
    const toGo = vercel.rewrites.filter((rule) => rule.destination.service === 'api').map((rule) => rule.source)
    assert.deepEqual([...toGo].sort(), [...GO_API_PATHS].sort())
    const last = vercel.rewrites.at(-1)
    assert.deepEqual(last, { source: '/(.*)', destination: { service: 'web' } }, 'the Next.js catch-all comes last')
    assert.equal(vercel.services.api?.root, 'backend')
  })

  it('no Next.js route file is left for a path the Go API serves', () => {
    for (const apiPath of GO_API_PATHS) {
      const file = path.join(process.cwd(), 'app', ...apiPath.split('/').filter(Boolean), 'route.ts')
      assert.equal(existsSync(file), false, `${path.relative(process.cwd(), file)} would be shadowed by the Go API`)
    }
  })
})
