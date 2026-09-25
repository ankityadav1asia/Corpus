import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as chatRoute from '@/app/api/chat/route'
import * as documentFileRoute from '@/app/api/corpus/documents/[id]/file/route'
import * as documentRoute from '@/app/api/corpus/documents/[id]/route'
import * as slackEventsRoute from '@/app/api/integrations/slack/[id]/events/route'
import * as teamsMessagesRoute from '@/app/api/integrations/teams/[id]/messages/route'
import * as uploadRoute from '@/app/api/learn/upload/route'
import * as followupsRoute from '@/app/api/messages/[id]/followups/route'
import * as publicShareRoute from '@/app/api/public/shares/[token]/route'
import * as shareRoute from '@/app/api/shares/[id]/route'
import * as sharesRoute from '@/app/api/shares/route'
import * as integrationRoute from '@/app/api/workspaces/[id]/integrations/[integrationId]/route'
import * as integrationsRoute from '@/app/api/workspaces/[id]/integrations/route'
import * as workspaceSharesRoute from '@/app/api/workspaces/[id]/shares/route'
import type { DocumentDetail, IntegrationSummary, ShareLink, SharedView, UploadResult } from '@/lib/contracts'
import { SESSION_COOKIE } from '@/server/auth/session'
import { resetEnvCache } from '@/server/env'
import { runJobs } from '@/server/jobs/runner'
import { setJobAutorun } from '@/server/jobs/trigger'
import { registryOf } from '@/server/connectors/registry'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { setServicesForTests, type Services } from '@/server/services'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, isFollowups, isRerank, type FakeAi } from './helpers/fake-ai'
import { addDocument, createTeam, createUser, type TestUser } from './helpers/fixtures'
import { sessionToken } from './helpers/session'
import { makePdf } from './helpers/pdf'

const SECRET = 'q'.repeat(48)
const ORIGIN = 'http://localhost:3000'
const TEAMS_APP_ID = '11111111-2222-4333-8444-555555555555'
const SLACK_SIGNING = 'slack-signing-secret-for-tests'

let t: TestDb
let repos: Repositories
let ai: FakeAi

interface Actor extends TestUser {
  cookie: string
}
let ada: Actor // admin
let ed: Actor // editor
let val: Actor // viewer
let team: { workspaceId: string; notebookId: string }

/* ── Fake Slack / Microsoft endpoints ─────────────────────────────────────── */

let signingKey: KeyObject
let publicJwk: { n: string; e: string }
const outbound: Array<{ url: string; body: string; auth: string | null }> = []

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : ''
  const auth = new Headers(init?.headers).get('authorization')
  outbound.push({ url, body, auth })
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  if (url === 'https://slack.com/api/auth.test')
    return auth === 'Bearer xoxb-good' ? reply({ ok: true, team: 'Acme', user: 'corpus' }) : reply({ ok: false, error: 'invalid_auth' })
  if (url === 'https://slack.com/api/chat.postMessage') return reply({ ok: true })
  if (url === 'https://login.botframework.com/v1/.well-known/openidconfiguration') return reply({ jwks_uri: 'https://login.botframework.com/v1/.well-known/keys' })
  if (url === 'https://login.botframework.com/v1/.well-known/keys') return reply({ keys: [{ kid: 'test-key', kty: 'RSA', ...publicJwk, endorsements: ['msteams'] }] })
  if (url.startsWith('https://login.microsoftonline.com/'))
    return body.includes('client_secret=right') ? reply({ access_token: 'bot-token', expires_in: 3600 }) : reply({ error: 'invalid_client' }, 401)
  if (url.startsWith('https://smba.trafficmanager.net/')) return reply({ id: 'reply-1' })
  return reply({ error: 'unexpected' }, 404)
}

function botFrameworkToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), signingKey).toString('base64url')
  return `${header}.${payload}.${signature}`
}

/* ── Harness ──────────────────────────────────────────────────────────────── */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

function call(
  handler: unknown,
  path: string,
  init: {
    method?: string
    as?: Actor | null
    workspace?: string | null
    body?: unknown
    form?: FormData
    raw?: string
    headers?: Record<string, string>
    params?: Record<string, string>
  } = {},
) {
  const headers = new Headers({ host: 'localhost:3000', ...init.headers })
  if (init.as) headers.set('cookie', `${SESSION_COOKIE}=${init.as.cookie}`)
  const method = init.method ?? 'GET'
  if (method !== 'GET' && init.as) headers.set('origin', ORIGIN)
  const workspace = init.workspace === undefined ? team.workspaceId : init.workspace
  if (workspace) headers.set('x-workspace-id', workspace)
  let body: BodyInit | undefined
  if (init.form) body = init.form
  else if (init.raw !== undefined) body = init.raw
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body)
    headers.set('content-type', 'application/json')
  }
  return (handler as Handler)(new NextRequest(`${ORIGIN}${path}`, { method, headers, body }), { params: Promise.resolve(init.params ?? {}) })
}

async function data<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

const jobs = () => runJobs({ repos, ai: () => ai, reranker: () => createLlmReranker(ai), images: () => null, secret: () => SECRET, fetch: fakeFetch }, { maxJobs: 20 })

async function actor(email: string): Promise<Actor> {
  const user = await createUser(repos, email)
  return { ...user, cookie: await sessionToken(repos, user.user, SECRET) }
}

before(async () => {
  process.env.AUTH_SECRET = SECRET
  process.env.POSTGRES_URL = 'postgres://unused'
  delete process.env.APP_URL
  resetEnvCache()
  setJobAutorun(false)
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  signingKey = keys.privateKey
  const jwk = keys.publicKey.export({ format: 'jwk' }) as { n: string; e: string }
  publicJwk = { n: jwk.n, e: jwk.e }

  t = await createTestDb()
  repos = createRepositories(t.db)
  ai = createFakeAi()
  const services: Services = {
    db: t.db,
    repos,
    ai: () => ai,
    reranker: () => createLlmReranker(ai),
    images: () => null,
    vision: () => null,
    transcriber: () => null,
    speech: () => null,
    ocr: () => null,
    connectors: () => registryOf({}),
    email: () => null,
    fetch: () => fakeFetch,
  }
  setServicesForTests(services)
  ada = await actor('ada@example.com')
  ed = await actor('ed@example.com')
  val = await actor('val@example.com')
  team = await createTeam(repos, ada, [
    [ed, 'editor'],
    [val, 'viewer'],
  ])
  await addDocument(repos, {
    workspaceId: team.workspaceId,
    collectionId: team.notebookId,
    createdBy: ada.id,
    title: 'Photosynthesis notes',
    chunks: ['What photosynthesis does: photosynthesis converts light into chemical energy.'],
  })
})

after(async () => {
  setServicesForTests(null)
  setJobAutorun(true)
  await t.close()
})

async function readStream(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe('faster answers', () => {
  it('skips thinking for the answer in standard mode and for every helper call', async () => {
    ai.calls.chat.length = 0
    ai.calls.complete.length = 0
    const events = await readStream(await call(chatRoute.POST, '/api/chat', { method: 'POST', as: ed, body: { message: 'What does photosynthesis convert?', mode: 'standard' } }))
    assert.equal(events.at(-1)?.type, 'done')
    assert.equal(ai.calls.chat.at(-1)?.fast, true)
    assert.ok(ai.calls.complete.filter(isRerank).every((input) => input.fast === true))

    const answered = ai.calls.chat.length
    await readStream(await call(chatRoute.POST, '/api/chat', { method: 'POST', as: ed, body: { message: 'What does photosynthesis convert?', mode: 'deep' } }))
    assert.equal(ai.calls.chat.length, answered + 1)
    assert.equal(ai.calls.chat.at(-1)?.fast, false, 'deep mode keeps the model’s thinking')
    assert.ok(ai.calls.complete.length > 1 && ai.calls.complete.every((input) => input.fast === true), 'planning and re-ranking use the fast path')
  })
})

describe('follow-up questions', () => {
  it('suggests them once per answer, stores them, and only for the author', async () => {
    const events = await readStream(await call(chatRoute.POST, '/api/chat', { method: 'POST', as: ed, body: { message: 'What does photosynthesis convert?', mode: 'standard' } }))
    const answerId = String(events.find((event) => event.type === 'done')!.assistantMessageId)
    const before = ai.calls.complete.filter(isFollowups).length

    const first = await data<{ followups: string[] }>(call(followupsRoute.POST, `/api/messages/${answerId}/followups`, { method: 'POST', as: ed, params: { id: answerId } }))
    assert.equal(first.followups.length, 3)
    const again = await data<{ followups: string[] }>(call(followupsRoute.POST, `/api/messages/${answerId}/followups`, { method: 'POST', as: ed, params: { id: answerId } }))
    assert.deepEqual(again.followups, first.followups)
    assert.equal(ai.calls.complete.filter(isFollowups).length, before + 1, 'generated once, then read back')
    assert.equal(ai.calls.complete.filter(isFollowups).at(-1)?.fast, true)

    const conversationId = String(events[0]!.conversationId)
    const [, answer] = await repos.conversations.messages(conversationId)
    assert.deepEqual(answer?.followups, first.followups, 'reopening the chat shows them')
    assert.equal((await call(followupsRoute.POST, `/api/messages/${answerId}/followups`, { method: 'POST', as: ada, params: { id: answerId } })).status, 404)
  })
})

describe('read-only share links', () => {
  let conversationId: string

  before(async () => {
    const conversation = await repos.conversations.create({ workspaceId: team.workspaceId, ownerId: ed.id, collectionId: null, title: 'Shared thread' })
    conversationId = conversation.id
    await repos.conversations.addMessage({ conversationId, role: 'user', content: 'Question one' })
    await repos.conversations.addMessage({
      conversationId,
      role: 'assistant',
      content: 'Answer one [1].',
      citations: [{ index: 1, chunkId: null, documentId: null, title: 'Notes', source: 'C:\\private\\notes.pdf', sourceType: 'file', excerpt: 'Excerpt', similarity: 0.9 }],
    })
  })

  it('shares a snapshot publicly; later messages stay private; revoking or deleting ends it', async () => {
    const created = await call(sharesRoute.POST, '/api/shares', { method: 'POST', as: ed, body: { kind: 'conversation', id: conversationId } })
    assert.equal(created.status, 201)
    const { link } = (await created.json()) as { link: ShareLink }
    const token = /\/s\/([A-Za-z0-9_-]{32})$/.exec(link.url ?? '')?.[1]
    assert.ok(token, link.url ?? 'no url')

    await repos.conversations.addMessage({ conversationId, role: 'user', content: 'A later, private question' })
    const view = await data<{ share: SharedView }>(call(publicShareRoute.GET, `/api/public/shares/${token}`, { as: null, workspace: null, params: { token } }))
    assert.equal(view.share.title, 'Shared thread')
    assert.equal(view.share.snapshot.kind, 'conversation')
    if (view.share.snapshot.kind === 'conversation') {
      assert.equal(view.share.snapshot.messages.length, 2, 'the snapshot, not the live thread')
      assert.equal(view.share.snapshot.messages[1]!.citations[0]!.source, 'notes.pdf', 'no internal paths')
      assert.ok(!('chunkId' in view.share.snapshot.messages[1]!.citations[0]!))
    }

    const listed = await data<{ links: ShareLink[] }>(call(sharesRoute.GET, `/api/shares?kind=conversation&id=${conversationId}`, { as: ed }))
    assert.equal(listed.links[0]?.url, link.url, 'the link can be copied again later')
    assert.equal(listed.links[0]?.viewCount, 1)

    assert.equal((await call(shareRoute.DELETE, `/api/shares/${link.id}`, { method: 'DELETE', as: val, params: { id: link.id } })).status, 403)
    assert.equal((await call(shareRoute.DELETE, `/api/shares/${link.id}`, { method: 'DELETE', as: ada, params: { id: link.id } })).status, 200, 'admins can turn any link off')
    assert.equal((await call(publicShareRoute.GET, `/api/public/shares/${token}`, { as: null, workspace: null, params: { token } })).status, 404)

    const second = await data<{ link: ShareLink }>(call(sharesRoute.POST, '/api/shares', { method: 'POST', as: ed, body: { kind: 'conversation', id: conversationId } }))
    const secondToken = second.link.url!.split('/s/')[1]!
    await repos.conversations.delete(team.workspaceId, ed.id, conversationId)
    assert.equal(
      (await call(publicShareRoute.GET, `/api/public/shares/${secondToken}`, { as: null, workspace: null, params: { token: secondToken } })).status,
      404,
      'deleted conversations are no longer shared',
    )
  })

  it('lists every active public link of the workspace for admins only', async () => {
    const mine = await repos.conversations.create({ workspaceId: team.workspaceId, ownerId: ed.id, collectionId: null, title: 'Listed thread' })
    await repos.conversations.addMessage({ conversationId: mine.id, role: 'user', content: 'hi' })
    const created = await data<{ link: ShareLink }>(call(sharesRoute.POST, '/api/shares', { method: 'POST', as: ed, body: { kind: 'conversation', id: mine.id } }))
    const path = `/api/workspaces/${team.workspaceId}/shares`
    assert.equal((await call(workspaceSharesRoute.GET, path, { as: ed, workspace: null, params: { id: team.workspaceId } })).status, 403)
    const listed = await data<{ links: ShareLink[] }>(call(workspaceSharesRoute.GET, path, { as: ada, workspace: null, params: { id: team.workspaceId } }))
    assert.ok(listed.links.some((link) => link.id === created.link.id && link.createdByEmail === 'ed@example.com'))
  })

  it('requires Editor access, the author’s own chat, and a finished report', async () => {
    const mine = await repos.conversations.create({ workspaceId: team.workspaceId, ownerId: val.id, collectionId: null, title: 'Viewer thread' })
    await repos.conversations.addMessage({ conversationId: mine.id, role: 'user', content: 'hello' })
    assert.equal((await call(sharesRoute.POST, '/api/shares', { method: 'POST', as: val, body: { kind: 'conversation', id: mine.id } })).status, 403)
    assert.equal((await call(sharesRoute.POST, '/api/shares', { method: 'POST', as: ed, body: { kind: 'conversation', id: mine.id } })).status, 404, 'someone else’s chat')

    const report = await repos.reports.create({
      workspaceId: team.workspaceId,
      createdBy: ada.id,
      template: 'executive_summary',
      format: 'markdown',
      title: 'Quarterly summary',
      instructions: null,
      collectionIds: [team.notebookId],
      documentIds: [],
    })
    assert.equal((await call(sharesRoute.POST, '/api/shares', { method: 'POST', as: ed, body: { kind: 'report', id: report.id } })).status, 400)
    await repos.reports.complete(report.id, { content: '# Summary\n\nAll good.', output: null, sources: [] })
    const shared = await data<{ link: ShareLink }>(call(sharesRoute.POST, '/api/shares', { method: 'POST', as: ed, body: { kind: 'report', id: report.id } }))
    const token = shared.link.url!.split('/s/')[1]!
    const view = await data<{ share: SharedView }>(call(publicShareRoute.GET, `/api/public/shares/${token}`, { as: null, workspace: null, params: { token } }))
    assert.deepEqual(view.share.snapshot, { kind: 'report', template: 'executive_summary', content: '# Summary\n\nAll good.' })
    assert.equal((await call(publicShareRoute.GET, '/api/public/shares/not-a-token', { as: null, workspace: null, params: { token: 'not-a-token' } })).status, 404)
  })
})

describe('original PDFs for the viewer', () => {
  it('keeps an uploaded PDF and serves it to members who can see the notebook', async () => {
    const form = new FormData()
    form.set('collectionId', team.notebookId)
    form.append('files', new File([Buffer.from(makePdf([{ text: ['Quarterly revenue grew by eighteen percent.'] }])) as BlobPart], 'q3.pdf', { type: 'application/pdf' }))
    const upload = await data<UploadResult>(call(uploadRoute.POST, '/api/learn/upload', { method: 'POST', as: ed, form }))
    const documentId = upload.results[0]!.document!.id

    const detail = await data<DocumentDetail>(call(documentRoute.GET, `/api/corpus/documents/${documentId}`, { as: val, params: { id: documentId } }))
    assert.equal(detail.file?.mimeType, 'application/pdf')
    const file = await call(documentFileRoute.GET, `/api/corpus/documents/${documentId}/file`, { as: val, params: { id: documentId } })
    assert.equal(file.status, 200)
    assert.equal(file.headers.get('content-type'), 'application/pdf')
    assert.equal(
      Buffer.from(await file.arrayBuffer())
        .subarray(0, 5)
        .toString(),
      '%PDF-',
    )

    const stranger = await actor('stranger@example.com')
    assert.equal((await call(documentFileRoute.GET, `/api/corpus/documents/${documentId}/file`, { as: stranger, params: { id: documentId } })).status, 404)
  })
})

describe('Slack bot', () => {
  let integration: IntegrationSummary
  const signed = (body: string, extra: Record<string, string> = {}) => {
    const ts = String(Math.floor(Date.now() / 1000))
    return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', SLACK_SIGNING).update(`v0:${ts}:${body}`).digest('hex')}`, ...extra }
  }

  it('is connected by admins after checking the token with Slack', async () => {
    const body = { provider: 'slack', name: 'Team bot', collectionId: team.notebookId, botToken: 'xoxb-good', signingSecret: SLACK_SIGNING }
    const path = `/api/workspaces/${team.workspaceId}/integrations`
    assert.equal((await call(integrationsRoute.POST, path, { method: 'POST', as: ed, workspace: null, body, params: { id: team.workspaceId } })).status, 403)
    assert.equal(
      (await call(integrationsRoute.POST, path, { method: 'POST', as: ada, workspace: null, body: { ...body, botToken: 'xoxb-bad' }, params: { id: team.workspaceId } })).status,
      400,
    )
    const created = await call(integrationsRoute.POST, path, { method: 'POST', as: ada, workspace: null, body, params: { id: team.workspaceId } })
    assert.equal(created.status, 201)
    integration = ((await created.json()) as { integration: IntegrationSummary }).integration
    assert.equal(integration.endpoint, `${ORIGIN}/api/integrations/slack/${integration.id}/events`)
    assert.equal(integration.account, 'Acme · @corpus')
    const listed = await data<{ integrations: IntegrationSummary[] }>(call(integrationsRoute.GET, path, { as: ada, workspace: null, params: { id: team.workspaceId } }))
    assert.equal(listed.integrations.length, 1)
    assert.ok(!JSON.stringify(listed).includes('xoxb-good') && !JSON.stringify(listed).includes(SLACK_SIGNING), 'secrets never leave the server')
  })

  it('verifies Slack signatures, answers mentions in the thread, and ignores retries', async () => {
    const path = `/api/integrations/slack/${integration.id}/events`
    const params = { id: integration.id }
    const challenge = JSON.stringify({ type: 'url_verification', challenge: 'xyz' })
    assert.deepEqual(await data(call(slackEventsRoute.POST, path, { method: 'POST', as: null, workspace: null, raw: challenge, headers: signed(challenge), params })), {
      challenge: 'xyz',
    })
    assert.equal(
      (
        await call(slackEventsRoute.POST, path, {
          method: 'POST',
          as: null,
          workspace: null,
          raw: challenge,
          headers: { ...signed(challenge), 'x-slack-signature': 'v0=bad' },
          params,
        })
      ).status,
      401,
    )

    const mention = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '100.1', text: '<@UBOT> What does photosynthesis convert?' },
    })
    await t.db.query(`DELETE FROM app.jobs`)
    assert.equal((await call(slackEventsRoute.POST, path, { method: 'POST', as: null, workspace: null, raw: mention, headers: signed(mention), params })).status, 200)
    await call(slackEventsRoute.POST, path, { method: 'POST', as: null, workspace: null, raw: mention, headers: signed(mention, { 'x-slack-retry-num': '1' }), params })
    const [queued] = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.jobs WHERE type = 'answer_bot_message'`)
    assert.equal(queued?.n, 1, 'retries are not answered twice')

    outbound.length = 0
    assert.deepEqual(await jobs(), { processed: 1, failed: 0 })
    const post = outbound.find((request) => request.url === 'https://slack.com/api/chat.postMessage')
    assert.ok(post)
    const message = JSON.parse(post.body) as { channel: string; thread_ts: string; text: string }
    assert.equal(message.channel, 'C1')
    assert.equal(message.thread_ts, '100.1')
    assert.match(message.text, /Answer from sources \[1\]\.[\s\S]*\*Sources\*\n\[1\] Photosynthesis notes/)
    assert.equal(post.auth, 'Bearer xoxb-good')
  })

  it('stops, instead of answering from every notebook, when its notebook is deleted', async () => {
    const notebook = (await repos.collections.create(team.workspaceId, ada.id, 'Public FAQ'))!
    const path = `/api/workspaces/${team.workspaceId}/integrations`
    const scoped = (
      await data<{ integration: IntegrationSummary }>(
        call(integrationsRoute.POST, path, {
          method: 'POST',
          as: ada,
          workspace: null,
          body: { provider: 'slack', name: 'FAQ bot', collectionId: notebook.id, botToken: 'xoxb-good', signingSecret: SLACK_SIGNING },
          params: { id: team.workspaceId },
        }),
      )
    ).integration
    assert.equal(scoped.allNotebooks, false)
    await repos.collections.delete(team.workspaceId, notebook.id)

    const mention = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev2',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '200.1', text: '<@UBOT> What does photosynthesis convert?' },
    })
    await t.db.query(`DELETE FROM app.jobs`)
    await call(slackEventsRoute.POST, `/api/integrations/slack/${scoped.id}/events`, {
      method: 'POST',
      as: null,
      workspace: null,
      raw: mention,
      headers: signed(mention),
      params: { id: scoped.id },
    })
    outbound.length = 0
    await jobs()
    const post = outbound.find((request) => request.url === 'https://slack.com/api/chat.postMessage')
    assert.match(JSON.parse(post!.body).text, /not connected to a notebook/)
    assert.ok(!JSON.parse(post!.body).text.includes('Photosynthesis'), 'no answer from other notebooks')
    const listed = await data<{ integrations: IntegrationSummary[] }>(call(integrationsRoute.GET, path, { as: ada, workspace: null, params: { id: team.workspaceId } }))
    const after = listed.integrations.find((item) => item.id === scoped.id)
    assert.equal(after?.status, 'error')
    assert.match(after?.lastError ?? '', /was deleted/)
    assert.equal(listed.integrations.find((item) => item.id === integration.id)?.allNotebooks, false, 'the first bot was limited to a notebook too')
  })

  it('stops answering once disconnected', async () => {
    const path = `/api/workspaces/${team.workspaceId}/integrations/${integration.id}`
    assert.equal(
      (await call(integrationRoute.DELETE, path, { method: 'DELETE', as: ed, workspace: null, params: { id: team.workspaceId, integrationId: integration.id } })).status,
      403,
    )
    assert.equal(
      (await call(integrationRoute.DELETE, path, { method: 'DELETE', as: ada, workspace: null, params: { id: team.workspaceId, integrationId: integration.id } })).status,
      200,
    )
    const body = JSON.stringify({ type: 'url_verification', challenge: 'x' })
    assert.equal(
      (
        await call(slackEventsRoute.POST, `/api/integrations/slack/${integration.id}/events`, {
          method: 'POST',
          as: null,
          workspace: null,
          raw: body,
          headers: signed(body),
          params: { id: integration.id },
        })
      ).status,
      404,
    )
  })
})

describe('Microsoft Teams bot', () => {
  let integration: IntegrationSummary
  const serviceUrl = 'https://smba.trafficmanager.net/amer/'
  const activity = { type: 'message', id: 'act-1', serviceUrl, channelId: 'msteams', conversation: { id: 'conv-1' }, text: '<at>Corpus</at> What does photosynthesis convert?' }
  const claims = (overrides: Record<string, unknown> = {}) => ({
    iss: 'https://api.botframework.com',
    aud: TEAMS_APP_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    nbf: Math.floor(Date.now() / 1000) - 10,
    serviceurl: serviceUrl,
    ...overrides,
  })

  before(async () => {
    const body = { provider: 'teams', name: 'Teams bot', collectionId: null, appId: TEAMS_APP_ID, appPassword: 'right', tenantId: null }
    const path = `/api/workspaces/${team.workspaceId}/integrations`
    assert.equal(
      (await call(integrationsRoute.POST, path, { method: 'POST', as: ada, workspace: null, body: { ...body, appPassword: 'wrong' }, params: { id: team.workspaceId } })).status,
      400,
    )
    integration = (
      await data<{ integration: IntegrationSummary }>(call(integrationsRoute.POST, path, { method: 'POST', as: ada, workspace: null, body, params: { id: team.workspaceId } }))
    ).integration
  })

  it('accepts only Bot Framework tokens for this bot and service URL, then replies in the conversation', async () => {
    const path = `/api/integrations/teams/${integration.id}/messages`
    const params = { id: integration.id }
    const post = (token: string, payload: unknown = activity) =>
      call(teamsMessagesRoute.POST, path, { method: 'POST', as: null, workspace: null, raw: JSON.stringify(payload), headers: { authorization: `Bearer ${token}` }, params })

    assert.equal((await post(botFrameworkToken(claims({ aud: 'someone-else' })))).status, 401)
    assert.equal((await post(botFrameworkToken(claims({ exp: Math.floor(Date.now() / 1000) - 3600 })))).status, 401)
    assert.equal((await post(botFrameworkToken(claims({ serviceurl: 'https://smba.trafficmanager.net/other/' })))).status, 401)
    assert.equal((await post(botFrameworkToken(claims({ serviceurl: undefined })))).status, 401, 'tokens must name their service URL')
    assert.equal((await post(botFrameworkToken(claims()), { ...activity, channelId: 'slack' })).status, 401, 'the key is only endorsed for Teams')
    assert.equal((await post(`${botFrameworkToken(claims())}x`)).status, 401)

    await t.db.query(`DELETE FROM app.jobs`)
    assert.equal((await post(botFrameworkToken(claims()))).status, 200)
    outbound.length = 0
    assert.deepEqual(await jobs(), { processed: 1, failed: 0 })
    const typing = outbound.find((request) => request.url === `${serviceUrl.replace(/\/$/, '')}/v3/conversations/conv-1/activities`)
    assert.equal(JSON.parse(typing!.body).type, 'typing')
    const reply = outbound.find((request) => request.url.endsWith('/v3/conversations/conv-1/activities/act-1'))
    assert.ok(reply)
    assert.equal(reply.auth, 'Bearer bot-token')
    const message = JSON.parse(reply.body) as { text: string; textFormat: string; replyToId: string }
    assert.equal(message.textFormat, 'markdown')
    assert.match(message.text, /Answer from sources \[1\]\.[\s\S]*\*\*Sources\*\*/)
  })
})
