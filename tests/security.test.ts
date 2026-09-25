import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as authRoute from '@/app/api/auth/route'
import { middleware } from '@/middleware'
import { clearSessionCacheForTests } from '@/server/auth/current-user'
import { completeLogin } from '@/server/auth/login'
import { SESSION_COOKIE } from '@/server/auth/session'
import { resetEnvCache } from '@/server/env'
import { createRepositories, type Repositories } from '@/server/repositories'
import { contentSecurityPolicy, createNonce } from '@/server/security/csp'
import { resealSecrets } from '@/server/security/rotation'
import { SecretUnreadableError, openSecret, sealSecret } from '@/server/security/secrets'
import { createShare, listWorkspaceShares, openShare, revokeShare } from '@/server/shares/service'
import { setServicesForTests, type Services } from '@/server/services'

import { createTestDb, type TestDb } from './helpers/db'
import { accessFor, createTeam, createUser } from './helpers/fixtures'

const SECRET = 's'.repeat(48)
const PREVIOUS = 'p'.repeat(48)
const ORIGIN = 'http://localhost:3000'

let t: TestDb
let repos: Repositories

before(async () => {
  process.env.AUTH_SECRET = SECRET
  delete process.env.AUTH_SECRET_PREVIOUS
  process.env.POSTGRES_URL = 'postgres://unused'
  resetEnvCache()
  t = await createTestDb()
  repos = createRepositories(t.db)
  setServicesForTests({ db: t.db, repos } as unknown as Services)
})

after(async () => {
  setServicesForTests(null)
  delete process.env.AUTH_SECRET_PREVIOUS
  resetEnvCache()
  await t.close()
})

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

function call(handler: unknown, path: string, token: string | null, method = 'GET') {
  const headers = new Headers({ host: 'localhost:3000' })
  if (token) headers.set('cookie', `${SESSION_COOKIE}=${token}`)
  if (method !== 'GET') headers.set('origin', ORIGIN)
  return (handler as Handler)(new NextRequest(`${ORIGIN}${path}`, { method, headers }), { params: Promise.resolve({}) })
}

describe('server-side sessions', () => {
  it('signing out revokes the token itself, not just the cookie', async () => {
    const { token } = await completeLogin(repos, { email: 'ada@example.com', name: 'Ada' }, 'test-agent')
    assert.equal((await call(authRoute.GET, '/api/auth', token)).status, 200)
    const signedOut = await call(authRoute.DELETE, '/api/auth', token, 'DELETE')
    assert.equal(signedOut.status, 200)
    assert.match(signedOut.headers.get('set-cookie') ?? '', /corpus_session=;/)
    assert.equal((await call(authRoute.GET, '/api/auth', token)).status, 401, 'a copied token stops working')
  })

  it('"sign out of all devices" ends every session of the account and no one else’s', async () => {
    const laptop = (await completeLogin(repos, { email: 'bo@example.com', name: null })).token
    const phone = (await completeLogin(repos, { email: 'bo@example.com', name: null })).token
    const other = (await completeLogin(repos, { email: 'cy@example.com', name: null })).token
    assert.equal((await call(authRoute.GET, '/api/auth', phone)).status, 200)
    assert.equal((await call(authRoute.DELETE, '/api/auth?scope=all', laptop, 'DELETE')).status, 200)
    assert.equal((await call(authRoute.GET, '/api/auth', laptop)).status, 401)
    assert.equal((await call(authRoute.GET, '/api/auth', phone)).status, 401)
    assert.equal((await call(authRoute.GET, '/api/auth', other)).status, 200)
  })

  it('rejects sessions revoked elsewhere (after the short cache) and expired sessions', async () => {
    const { token, user } = await completeLogin(repos, { email: 'di@example.com', name: null })
    assert.equal((await call(authRoute.GET, '/api/auth', token)).status, 200)
    await t.db.query(`UPDATE app.sessions SET revoked_at = now() WHERE user_id = $1`, [user.id]) // another server instance
    clearSessionCacheForTests()
    assert.equal((await call(authRoute.GET, '/api/auth', token)).status, 401)

    const second = await completeLogin(repos, { email: 'di@example.com', name: null })
    await t.db.query(`UPDATE app.sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND revoked_at IS NULL`, [user.id])
    clearSessionCacheForTests()
    assert.equal((await call(authRoute.GET, '/api/auth', second.token)).status, 401)
  })

  it('signing out without a session, or with garbage, still clears the cookie', async () => {
    assert.equal((await call(authRoute.DELETE, '/api/auth', null, 'DELETE')).status, 200)
    assert.equal((await call(authRoute.DELETE, '/api/auth', 'garbage', 'DELETE')).status, 200)
  })
})

describe('rotating AUTH_SECRET', () => {
  it('keeps old sessions valid with AUTH_SECRET_PREVIOUS and re-seals stored secrets with the new key', async () => {
    // Sign in and store secrets under the old key…
    process.env.AUTH_SECRET = PREVIOUS
    resetEnvCache()
    const { token } = await completeLogin(repos, { email: 'eve@example.com', name: null })
    const owner = await createUser(repos, 'owner@example.com')
    const team = await createTeam(repos, owner)
    const connection = await repos.connectors.saveConnection({
      workspaceId: team.workspaceId,
      userId: owner.id,
      provider: 'notion',
      accountLabel: 'Notion',
      credentials: await sealSecret('{"token":"secret_abc"}', PREVIOUS),
    })
    const [stranger] = await t.db.query<{ id: string }>(
      `INSERT INTO app.connections (workspace_id, user_id, provider, account_label, credentials) VALUES ($1, $2, 'github', 'x', $3) RETURNING id`,
      [team.workspaceId, owner.id, await sealSecret('{}', 'z'.repeat(48))],
    )

    // …then rotate: new AUTH_SECRET, old one as AUTH_SECRET_PREVIOUS.
    process.env.AUTH_SECRET = SECRET
    process.env.AUTH_SECRET_PREVIOUS = PREVIOUS
    resetEnvCache()
    clearSessionCacheForTests()
    assert.equal((await call(authRoute.GET, '/api/auth', token)).status, 200, 'existing sessions survive the rotation')

    const report = await resealSecrets(repos, [SECRET, PREVIOUS])
    assert.ok(report.resealed >= 1)
    assert.deepEqual(report.unreadable, [{ kind: 'connections', id: stranger!.id }], 'unknown keys are reported, not deleted')
    const [row] = await t.db.query<{ credentials: string }>(`SELECT credentials FROM app.connections WHERE id = $1`, [connection.id])
    assert.equal(await openSecret(row!.credentials, SECRET), '{"token":"secret_abc"}', 'readable with the new key alone')
    await assert.rejects(openSecret(row!.credentials, PREVIOUS), SecretUnreadableError)

    // Once AUTH_SECRET_PREVIOUS is removed, tokens signed with the old key stop working.
    delete process.env.AUTH_SECRET_PREVIOUS
    resetEnvCache()
    clearSessionCacheForTests()
    assert.equal((await call(authRoute.GET, '/api/auth', token)).status, 401)
  })

  it('after replacing a leaked secret, public links stay listed (without their address) so admins can turn them off', async () => {
    const owner = await createUser(repos, 'links-owner@example.com')
    const team = await createTeam(repos, owner)
    const access = accessFor(owner.id, team.workspaceId, 'admin')
    const conversation = await repos.conversations.create({ workspaceId: team.workspaceId, ownerId: owner.id, collectionId: null, title: 'Shared before the leak' })
    await repos.conversations.addMessage({ conversationId: conversation.id, role: 'user', content: 'Question' })
    await repos.conversations.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'Answer' })
    const link = await createShare(repos, access, { kind: 'conversation', id: conversation.id }, ORIGIN, PREVIOUS)
    const token = link.url!.split('/s/')[1]!

    const [listed] = await listWorkspaceShares(repos, access, ORIGIN, SECRET)
    assert.equal(listed?.id, link.id)
    assert.equal(listed?.url, null, 'the address cannot be rebuilt without the old key')
    assert.ok(await openShare(repos, token), 'people who have the link can still open it')
    await revokeShare(repos, access, link.id)
    assert.equal(await openShare(repos, token), null)
  })
})

describe('content security policy', () => {
  it('uses a fresh nonce instead of unsafe-inline for scripts', () => {
    const a = createNonce()
    const b = createNonce()
    assert.notEqual(a, b)
    assert.match(a, /^[A-Za-z0-9+/]{22}==$/)
    const policy = contentSecurityPolicy(a, { development: false })
    const scriptSrc = policy.split('; ').find((directive) => directive.startsWith('script-src'))
    assert.equal(scriptSrc, `script-src 'self' 'nonce-${a}'`)
    assert.ok(policy.includes("frame-ancestors 'none'") && policy.includes("object-src 'none'") && policy.includes('upgrade-insecure-requests'))
    assert.ok(contentSecurityPolicy(a, { development: true }).includes("'unsafe-eval'"), 'dev tooling only')
  })

  it('middleware sends the policy and hands the same nonce to the page renderer', async () => {
    const res = await middleware(new NextRequest(`${ORIGIN}/login`))
    const policy = res.headers.get('content-security-policy') ?? ''
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1]
    assert.ok(nonce)
    assert.equal(res.headers.get('x-middleware-request-x-nonce'), nonce)
    const again = await middleware(new NextRequest(`${ORIGIN}/login`))
    assert.notEqual(/'nonce-([^']+)'/.exec(again.headers.get('content-security-policy') ?? '')?.[1], nonce, 'one nonce per request')
  })

  it('middleware still redirects or refuses requests without a valid session', async () => {
    const page = await middleware(new NextRequest(`${ORIGIN}/`))
    assert.equal(page.status, 307)
    const api = await middleware(new NextRequest(`${ORIGIN}/api/collections`))
    assert.equal(api.status, 401)
  })
})
