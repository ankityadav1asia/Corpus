import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isPublicPath } from '@/server/auth/public-paths'
import { SESSION_TTL_SECONDS, createSessionToken, readSessionToken, signToken, verifyToken } from '@/server/auth/session'

const SECRET = 'test-secret-that-is-definitely-longer-than-32-chars'
const USER = { id: '6f1c2a1e-0000-4000-8000-000000000001', email: 'a@example.com', name: 'Ada' }
const SESSION = { id: '0b2c3d4e-0000-4000-8000-000000000002', user: USER }
const PREVIOUS = 'the-previous-secret-that-is-also-longer-than-32-chars'

describe('session tokens', () => {
  it('round-trips a valid session', async () => {
    const token = await createSessionToken(SESSION, SECRET)
    const claims = await readSessionToken(token, SECRET)
    assert.equal(claims?.sub, USER.id)
    assert.equal(claims?.sid, SESSION.id)
    assert.equal(claims?.email, USER.email)
    assert.equal(claims?.exp, (claims?.iat ?? 0) + SESSION_TTL_SECONDS)
  })

  it('rejects a token signed with any other secret (there is no fallback secret)', async () => {
    const forged = await createSessionToken(SESSION, 'a-key-the-server-does-not-know-0123456789')
    assert.equal(await readSessionToken(forged, SECRET), null)
  })

  it('rejects a tampered payload', async () => {
    const token = await createSessionToken(SESSION, SECRET)
    const [, signature] = token.split('.')
    const evil = Buffer.from(JSON.stringify({ v: 2, sid: SESSION.id, sub: 'attacker', email: 'x@y.z', name: null, iat: 1, exp: 9e9 })).toString('base64url')
    assert.equal(await readSessionToken(`${evil}.${signature}`, SECRET), null)
  })

  it('rejects expired tokens and tokens issued in the future', async () => {
    const issued = Date.now() - (SESSION_TTL_SECONDS + 10) * 1000
    assert.equal(await readSessionToken(await createSessionToken(SESSION, SECRET, issued), SECRET), null)
    const future = Date.now() + 10 * 60_000
    assert.equal(await readSessionToken(await createSessionToken(SESSION, SECRET, future), SECRET), null)
  })

  it('rejects malformed tokens without throwing', async () => {
    for (const token of ['', 'abc', 'a.b.c', '.', 'x.' + 'A'.repeat(43), '%%%.%%%']) {
      assert.equal(await verifyToken(token, SECRET), null, token)
    }
  })

  it('rejects the old stateless v1 tokens, which name no server-side session', async () => {
    const legacy = await signToken({ v: 1, sub: USER.id, email: USER.email, name: USER.name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)
    assert.equal(await readSessionToken(legacy, SECRET), null)
  })

  it('accepts tokens signed with the previous secret during a rotation, and signs with the current one', async () => {
    const old = await createSessionToken(SESSION, PREVIOUS)
    assert.equal(await readSessionToken(old, SECRET), null, 'not without the previous key')
    assert.equal((await readSessionToken(old, [SECRET, PREVIOUS]))?.sid, SESSION.id)
    const fresh = await createSessionToken(SESSION, [SECRET, PREVIOUS])
    assert.equal((await readSessionToken(fresh, SECRET))?.sid, SESSION.id, 'new tokens use the current key')
  })

  it('rejects payloads that are validly signed but not session claims', async () => {
    const token = await signToken({ hello: 'world' }, SECRET)
    assert.deepEqual(await verifyToken(token, SECRET), { hello: 'world' })
    assert.equal(await readSessionToken(token, SECRET), null)
  })
})

describe('middleware public paths (fail closed)', () => {
  it('only exact allowlisted paths are public', () => {
    for (const path of ['/login', '/api/health', '/api/auth/otp/send', '/api/auth/oauth/callback']) {
      assert.equal(isPublicPath(path), true, path)
    }
    // The old rule made every path public because '/' matched as a prefix.
    for (const path of ['/', '/api/corpus', '/api/corpus/chunks', '/api/chat', '/api/learn/url', '/login/x', '/api/auth/oauth/evil', '/API/health']) {
      assert.equal(isPublicPath(path), false, path)
    }
  })
})
