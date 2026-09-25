import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { EMBEDDING_DIMENSIONS } from '@/lib/constants'
import { completeLogin, isEmailAllowed } from '@/server/auth/login'
import { OTP_MAX_ATTEMPTS, generateOtpCode, hashOtp, requestOtp, verifyOtp, type OtpDeps } from '@/server/auth/otp'
import { readSessionToken } from '@/server/auth/session'
import { importLegacyData } from '@/server/db/import-legacy'
import type { EmailSender } from '@/server/email/sender'
import { resetEnvCache } from '@/server/env'
import { AppError } from '@/server/http/errors'
import { createRepositories, type Repositories } from '@/server/repositories'

import { createTestDb, type TestDb } from './helpers/db'
import { fakeEmbedding } from './helpers/fake-ai'

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

describe('legacy data import', () => {
  const vector = (text: string) => `[${fakeEmbedding(text).join(',')}]`

  before(async () => {
    // Schema written by the previous version of the app (scripts/init-db.ts + LangChain).
    await t.db.query(`CREATE TABLE public.vectorstore_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), text text, metadata jsonb, embedding vector)`)
    await t.db.query(`ALTER TABLE public.vectorstore_documents ADD COLUMN collection_id text DEFAULT 'default'`)
    await t.db.query(
      `CREATE TABLE public.conversations (id text PRIMARY KEY, title text NOT NULL, collection_id text DEFAULT 'default', parent_id text, branch_message_id text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`,
    )
    await t.db.query(
      `CREATE TABLE public.messages (id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES public.conversations(id), role text NOT NULL, content text NOT NULL, citations jsonb, agent_steps jsonb, created_at timestamptz DEFAULT now())`,
    )
    const rows: Array<[string, object, string | null]> = [
      ['Research chunk one about enzymes', { source: 'file:paper.pdf', collection_id: 'research' }, vector('enzymes')],
      ['Research chunk two about enzymes', { source: 'file:paper.pdf', collection_id: 'research' }, vector('enzymes two')],
      ['Web page text', { source: 'https://example.com/post', title: 'A Post' }, vector('web')],
      ['Video words', { source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', collection_id: 'research' }, vector('video')],
      ['Bad embedding', { source: 'manual-input' }, '[1,2,3]'],
    ]
    for (const [text, metadata, embedding] of rows) {
      await t.db.query(`INSERT INTO public.vectorstore_documents (text, metadata, embedding) VALUES ($1, $2::jsonb, $3::vector)`, [text, JSON.stringify(metadata), embedding])
    }
    await t.db.query(`INSERT INTO public.conversations (id, title, collection_id) VALUES ('conv_1', 'Old chat', 'research'), ('branch_2', '↳ Old chat', 'research')`)
    await t.db.query(`UPDATE public.conversations SET parent_id = 'conv_1' WHERE id = 'branch_2'`)
    await t.db.query(
      `INSERT INTO public.messages (id, conversation_id, role, content, citations, created_at) VALUES
        ('msg_user_1', 'conv_1', 'user', 'What are enzymes?', NULL, now() - interval '2 minutes'),
        ('msg_asst_1', 'conv_1', 'assistant', 'Proteins. <!--CITATIONS:[{"index":1}]-->', '[{"id":"x","index":1,"source":"file:paper.pdf","score":1.6,"excerpt":"Research chunk"}]', now() - interval '1 minute'),
        ('msg_sys', 'conv_1', 'system', 'ignored', NULL, now())`,
    )
  })

  it('imports chunks with their embeddings, recovers notebooks from metadata and is idempotent', async () => {
    const first = await importLegacyData(t.db, 'Legacy@Example.com')
    assert.deepEqual(first, { collections: 2, documents: 3, chunks: 4, skippedChunks: 1, conversations: 2, messages: 2 })
    const second = await importLegacyData(t.db, 'legacy@example.com')
    assert.deepEqual(second, { collections: 0, documents: 0, chunks: 0, skippedChunks: 1, conversations: 0, messages: 0 })

    const owner = (await repos.users.upsertOnLogin('legacy@example.com', null)).user.id
    const workspaceId = await repos.workspaces.ensurePersonal(owner)
    const collections = await repos.collections.list(workspaceId, owner)
    assert.deepEqual(collections.map((c) => c.name).sort(), ['General', 'Research'])
    const research = collections.find((c) => c.name === 'Research')!
    const documents = await repos.documents.list(workspaceId, research.id)
    assert.deepEqual(documents.map((d) => d.sourceType).sort(), ['file', 'youtube'])
    assert.equal(documents.find((d) => d.sourceType === 'file')?.source, 'paper.pdf')

    const hits = await repos.documents.vectorSearch({ workspaceId, collectionId: research.id, embedding: fakeEmbedding('enzymes'), limit: 1 })
    assert.equal(hits[0]?.content, 'Research chunk one about enzymes')
  })

  it('imports conversations with branch links, strips old markers and maps citations', async () => {
    const owner = (await repos.users.upsertOnLogin('legacy@example.com', null)).user.id
    const workspaceId = await repos.workspaces.ensurePersonal(owner)
    const conversations = await repos.conversations.list(workspaceId, owner)
    const original = conversations.find((c) => c.title === 'Old chat')!
    const branch = conversations.find((c) => c.title === '↳ Old chat')!
    assert.equal(branch.parentId, original.id)
    const messages = await repos.conversations.messages(original.id)
    assert.deepEqual(
      messages.map((m) => m.role),
      ['user', 'assistant'],
    )
    assert.equal(messages[1]!.content, 'Proteins.')
    assert.equal(messages[1]!.citations[0]?.source, 'file:paper.pdf')
    assert.equal(messages[1]!.citations[0]?.index, 1)
  })

  it('never modifies the legacy tables', async () => {
    const [row] = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.vectorstore_documents')
    assert.equal(row?.n, 5)
    assert.equal(EMBEDDING_DIMENSIONS, 3072)
  })
})
