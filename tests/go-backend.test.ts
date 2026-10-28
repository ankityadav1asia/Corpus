import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import nextConfig, { GO_API_PATHS } from '../next.config.mjs'

/**
 * The Go backend (backend/, deployed as the Vercel Go Function api/go.go) serves some API paths
 * instead of Next.js. next.config.mjs rewrites them to it, the Go router must know each of them, and
 * no Next.js route file may still exist for them (it would shadow the rewrite).
 */
describe('Go backend routing', () => {
  it('rewrites every Go path to the Go Function in production', async () => {
    const rewrites = (await nextConfig.rewrites!()) as Array<{ source: string; destination: string }>
    assert.deepEqual(
      rewrites.map((rule) => rule.source),
      GO_API_PATHS,
    )
    assert.ok(rewrites.every((rule) => rule.destination === '/api/go'))
    assert.ok(existsSync(path.join(process.cwd(), 'api', 'go.go')))
  })

  it('the Go router registers every Go path', () => {
    const server = readFileSync(path.join(process.cwd(), 'backend', 'api', 'server.go'), 'utf8')
    for (const apiPath of GO_API_PATHS) {
      // next.config.mjs writes parameters as :id, Go's ServeMux as {id}.
      const pattern = apiPath.replace(/:(\w+)/g, '{$1}')
      assert.match(server, new RegExp(`mux\\.Handle\\("(GET|POST|PUT|PATCH|DELETE) ${pattern.replace(/[{}]/g, '\\$&')}"`), apiPath)
    }
  })

  it('no Next.js route file is left for a path the Go API serves', () => {
    for (const apiPath of GO_API_PATHS) {
      const file = path.join(
        process.cwd(),
        'app',
        ...apiPath
          .replace(/:(\w+)/g, '[$1]')
          .split('/')
          .filter(Boolean),
        'route.ts',
      )
      assert.equal(existsSync(file), false, `${path.relative(process.cwd(), file)} would shadow the Go API`)
    }
  })
})
