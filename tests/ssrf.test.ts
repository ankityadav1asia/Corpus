import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import zlib from 'node:zlib'

import { AppError } from '@/server/http/errors'
import { isPublicIp, parseFetchableUrl, safeFetchText } from '@/server/security/ssrf'

describe('isPublicIp', () => {
  it('blocks loopback, private, link-local (cloud metadata), CGNAT, multicast and IPv6 equivalents', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::',
    ]) {
      assert.equal(isPublicIp(ip), false, ip)
    }
  })

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPublicIp(ip), true, ip)
  })

  it('treats garbage as not public', () => {
    assert.equal(isPublicIp('localhost'), false)
    assert.equal(isPublicIp(''), false)
  })
})

describe('parseFetchableUrl', () => {
  const rejects = (url: string) =>
    assert.throws(
      () => parseFetchableUrl(url),
      (e: unknown) => e instanceof AppError && e.status === 400,
      url,
    )

  it('rejects non-http schemes, credentials, odd ports and private IP literals in any notation', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'javascript:alert(1)',
      'http://user:pass@example.com/',
      'http://example.com:22/',
      'http://127.0.0.1/',
      'http://2130706433/', // decimal 127.0.0.1
      'http://0x7f.0.0.1/', // hex
      'http://0177.0.0.1/', // octal
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://169.254.169.254/latest/meta-data/',
      'not a url',
    ]) {
      rejects(url)
    }
  })

  it('accepts public http(s) URLs', () => {
    assert.equal(parseFetchableUrl('https://example.com/a?b=c').hostname, 'example.com')
    assert.equal(parseFetchableUrl('http://example.com:8080/').port, '8080')
  })
})

describe('safeFetchText', () => {
  let server: http.Server
  let base: string
  let ports: ReadonlySet<string>
  // Permissive policy for the local test server, except 127.0.0.2 which stands in for "internal".
  const addressPolicy = (ip: string) => ip !== '127.0.0.2'

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      switch (url.pathname) {
        case '/page':
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          return res.end('<html><head><title>Hi</title></head><body>héllo</body></html>')
        case '/gzip':
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
          return res.end(zlib.gzipSync('compressed body'))
        case '/big':
          res.writeHead(200, { 'content-type': 'text/plain' })
          return res.end('x'.repeat(200_000))
        case '/bomb':
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
          return res.end(zlib.gzipSync(Buffer.alloc(5_000_000, 0x61)))
        case '/binary':
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          return res.end('...')
        case '/to-internal':
          res.writeHead(302, { location: `http://127.0.0.2:${(server.address() as AddressInfo).port}/page` })
          return res.end()
        case '/loop':
          res.writeHead(302, { location: '/loop' })
          return res.end()
        case '/slow':
          setTimeout(() => res.end('late'), 2_000)
          return
        default:
          res.writeHead(404)
          return res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}`
    ports = new Set([String(port)])
  })

  after(() => {
    server.closeAllConnections()
    server.close()
  })

  const fetchOk = (path: string, extra = {}) => safeFetchText(`${base}${path}`, { addressPolicy, allowedPorts: ports, ...extra })
  const failsWith = async (promise: Promise<unknown>, status: number) => assert.rejects(promise, (e: unknown) => e instanceof AppError && e.status === status)

  it('fetches and decodes a page', async () => {
    const page = await fetchOk('/page')
    assert.match(page.body, /héllo/)
    assert.match(page.contentType, /text\/html/)
  })

  it('decompresses gzip', async () => {
    assert.equal((await fetchOk('/gzip')).body, 'compressed body')
  })

  it('caps body size, including decompressed size (zip bombs)', async () => {
    await failsWith(fetchOk('/big', { maxBytes: 100_000 }), 413)
    await failsWith(fetchOk('/bomb', { maxBytes: 1_000_000 }), 413)
  })

  it('rejects non-text content types', async () => {
    await failsWith(fetchOk('/binary'), 415)
  })

  it('re-validates every redirect hop and blocks redirects into internal addresses', async () => {
    await failsWith(fetchOk('/to-internal'), 400)
    await failsWith(fetchOk('/loop'), 502)
  })

  it('times out slow servers', async () => {
    await failsWith(fetchOk('/slow', { timeoutMs: 300 }), 502)
  })

  it('with the real policy, a hostname resolving to loopback is blocked at DNS time', async () => {
    await failsWith(safeFetchText('http://localhost:8080/'), 400)
  })

  it('with the real policy, the running local server cannot be reached by IP either', async () => {
    await failsWith(safeFetchText(`${base}/page`, { allowedPorts: ports }), 400)
  })
})
