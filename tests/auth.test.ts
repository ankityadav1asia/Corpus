import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { completeLogin, isEmailAllowed } from '@/server/auth/login'
import { OTP_MAX_ATTEMPTS, generateOtpCode, hashOtp, requestOtp, verifyOtp, type OtpDeps } from '@/server/auth/otp'
import { readSessionToken } from '@/server/auth/session'
import type { EmailSender } from '@/server/email/sender'
import { resetEnvCache } from '@/server/env'
import { AppError } from '@/server/http/errors'
import { createRepositories, type Repositories } from '@/server/repositories'

import { createTestDb, type TestDb } from './helpers/db'

const SECRET = 'x'.repeat(48)
let t: TestDb
let repos: Repositories
const sent: Array<{ to: string; code: string }> = []
const sender: EmailSender = {
  async sendOtp(to, code) {
    sent.push({ to, code })
  },
}

function deps(overrides: Partial<OtpDeps> = {}): OtpDeps {
  return { repos, email: sender, secret: SECRET, isProduction: false, ...overrides }
}

const isStatus = (status: number) => (e: unknown) => e instanceof AppError && e.status === status

before(async () => {
  process.env.AUTH_SECRET = SECRET
  process.env.POSTGRES_URL = 'postgres://unused'
  delete process.env.AUTH_ALLOWED_EMAILS
  delete process.env.AUTH_ALLOWED_DOMAINS
  resetEnvCache()
  t = await createTestDb()
  repos = createRepositories(t.db)
})

after(() => t.close())

beforeEach(async () => {
  sent.length = 0
  await t.db.query('DELETE FROM app.rate_limits')
  await t.db.query('DELETE FROM app.otp_codes')
})

describe('one-time code sign-in', () => {
  it('generates uniformly formatted 6-digit codes', () => {
    for (let i = 0; i < 200; i++) assert.match(generateOtpCode(), /^\d{6}$/)
  })

  it('stores only a hash, verifies once, and never reuses a code', async () => {
    await requestOtp(deps(), { email: 'user@example.com', ip: 'ip1' })
    const code = sent[0]!.code
    const [row] = await t.db.query<{ code_hash: string }>('SELECT code_hash FROM app.otp_codes WHERE email = $1', ['user@example.com'])
    assert.ok(row && row.code_hash !== code && row.code_hash.length === 64)

    await verifyOtp(deps(), { email: 'user@example.com', code, ip: 'ip1' })
    await assert.rejects(verifyOtp(deps(), { email: 'user@example.com', code, ip: 'ip1' }), isStatus(400))
  })

  it(`locks the code after ${OTP_MAX_ATTEMPTS} attempts, even if the next guess is right`, async () => {
    await requestOtp(deps(), { email: 'brute@example.com', ip: 'ip2' })
    const code = sent[0]!.code
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await assert.rejects(verifyOtp(deps(), { email: 'brute@example.com', code: wrong, ip: 'ip2' }), isStatus(400))
    }
    await assert.rejects(verifyOtp(deps(), { email: 'brute@example.com', code, ip: 'ip2' }), isStatus(400))
  })

  it('answers every failed verification the same way (wrong code, or no code sent to that address)', async () => {
    await requestOtp(deps(), { email: 'same@example.com', ip: 'ip5' })
    const wrong = sent[0]!.code === '000000' ? '111111' : '000000'
    const messages: string[] = []
    for (const email of ['same@example.com', 'never-asked@example.com']) {
      await verifyOtp(deps(), { email, code: wrong, ip: 'ip5' }).catch((error: AppError) => messages.push(error.message))
    }
    assert.equal(messages.length, 2)
    assert.equal(messages[0], messages[1])
  })

  it('caps guesses per address per day, even across new codes', async () => {
    const email = 'patient@example.com'
    let code = ''
    for (let round = 0; round < 4; round++) {
      // Each new code resets its own 5-attempt counter; the daily per-address budget does not reset.
      code = generateOtpCode()
      await repos.otp.save(email, hashOtp(SECRET, email, code), 600)
      const wrong = code === '000000' ? '111111' : '000000'
      for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) await assert.rejects(verifyOtp(deps(), { email, code: wrong, ip: `ip-${round}-${i}` }), isStatus(400))
    }
    code = generateOtpCode()
    await repos.otp.save(email, hashOtp(SECRET, email, code), 600)
    await assert.rejects(verifyOtp(deps(), { email, code, ip: 'ip-last' }), isStatus(429), 'even the right code waits until tomorrow')
  })

  it('rate-limits code requests per email', async () => {
    for (let i = 0; i < 3; i++) await requestOtp(deps(), { email: 'spam@example.com', ip: `ip-${i}` })
    await assert.rejects(requestOtp(deps(), { email: 'spam@example.com', ip: 'ip-new' }), isStatus(429))
  })

  it('in production without an email provider it fails instead of leaking the code', async () => {
    await assert.rejects(requestOtp(deps({ email: null, isProduction: true }), { email: 'p@example.com', ip: 'ip3' }), isStatus(503))
  })

  it('does not reveal whether an address is on the allowlist', async () => {
    process.env.AUTH_ALLOWED_DOMAINS = 'company.com'
    resetEnvCache()
    try {
      await requestOtp(deps(), { email: 'outsider@gmail.com', ip: 'ip4' })
      assert.equal(sent.length, 0, 'no email for non-allowed address, but no error either')
      await requestOtp(deps(), { email: 'staff@company.com', ip: 'ip4' })
      assert.equal(sent.length, 1)
      assert.equal(isEmailAllowed('STAFF@Company.com'), true)
      await assert.rejects(completeLogin(repos, { email: 'outsider@gmail.com', name: null }), isStatus(403))
    } finally {
      delete process.env.AUTH_ALLOWED_DOMAINS
      resetEnvCache()
    }
  })

  it('completeLogin creates the user, a personal workspace with a default notebook and a valid session', async () => {
    const { user, token } = await completeLogin(repos, { email: 'New@Example.com', name: 'New' })
    assert.equal(user.email, 'new@example.com')
    const workspaces = await repos.workspaces.listForUser(user.id)
    assert.deepEqual(
      workspaces.map((w) => [w.isPersonal, w.role]),
      [[true, 'admin']],
    )
    assert.equal((await repos.collections.list(workspaces[0]!.id, user.id)).length, 1)
    assert.equal((await readSessionToken(token, SECRET))?.sub, user.id)
    await completeLogin(repos, { email: 'new@example.com', name: null })
    assert.equal((await repos.workspaces.listForUser(user.id)).length, 1, 'signing in again creates nothing new')
  })

  it('pending workspace invitations are accepted at sign-in, but never override the allowlist', async () => {
    const { user: admin } = await completeLogin(repos, { email: 'lead@company.com', name: 'Lead' })
    const team = await repos.workspaces.create('Research team', admin.id)
    await repos.workspaces.upsertInvite(team.id, 'Invitee@Company.com', 'editor', admin.id)
    await repos.workspaces.upsertInvite(team.id, 'outsider@gmail.com', 'viewer', admin.id)

    process.env.AUTH_ALLOWED_DOMAINS = 'company.com'
    resetEnvCache()
    try {
      await assert.rejects(completeLogin(repos, { email: 'outsider@gmail.com', name: null }), isStatus(403))
      const { user } = await completeLogin(repos, { email: 'invitee@company.com', name: null })
      const memberships = await repos.workspaces.listForUser(user.id)
      assert.deepEqual(memberships.map((w) => [w.name, w.role]).sort(), [
        ['Personal', 'admin'],
        ['Research team', 'editor'],
      ])
    } finally {
      delete process.env.AUTH_ALLOWED_DOMAINS
      resetEnvCache()
    }
    assert.deepEqual(
      (await repos.workspaces.invites(team.id)).map((invite) => invite.email),
      ['outsider@gmail.com'],
      'the rejected address keeps its invitation until it is allowed to sign in',
    )
  })
})
