import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as authRoute from '@/app/api/auth/route'
import * as demoRoute from '@/app/api/auth/demo/route'
import * as chatRoute from '@/app/api/chat/route'
import * as uploadsRoute from '@/app/api/learn/uploads/route'
import * as followupsRoute from '@/app/api/messages/[id]/followups/route'
import * as membersRoute from '@/app/api/workspaces/[id]/members/route'
import * as workspacesRoute from '@/app/api/workspaces/route'
import type { SessionUser, WorkspaceMember, WorkspaceSummary } from '@/lib/contracts'
import { clearSessionCacheForTests } from '@/server/auth/current-user'
import { enforceDemoQuestionLimits, purgeGuests } from '@/server/auth/demo'
import { isGuestEmail } from '@/server/auth/guest'
import { isPublicPath } from '@/server/auth/public-paths'
import { SESSION_COOKIE } from '@/server/auth/session'
import { getDemoConfig, resetEnvCache } from '@/server/env'
import { setJobAutorun } from '@/server/jobs/trigger'
import { registryOf } from '@/server/connectors/registry'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { setServicesForTests, type Services } from '@/server/services'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, type FakeAi } from './helpers/fake-ai'
import { addDocument, createTeam, createUser, type TestUser } from './helpers/fixtures'
import { sessionToken } from './helpers/session'

const SECRET = 'd'.repeat(48)
const ORIGIN = 'http://localhost:3000'

let t: TestDb
let repos: Repositories
let ai: FakeAi
let ada: TestUser & { cookie: string } // admin of the demo workspace
let team: { workspaceId: string; notebookId: string }
let nextIp = 1

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

function call(
  handler: unknown,
  path: string,
  init: { method?: string; cookie?: string; workspace?: string | null; body?: unknown; params?: Record<string, string>; ip?: string } = {},
): Promise<Response> {
  const method = init.method ?? 'GET'
  const headers = new Headers({ host: 'localhost:3000', 'x-forwarded-for': init.ip ?? '203.0.113.1' })
  if (init.cookie) headers.set('cookie', `${SESSION_COOKIE}=${init.cookie}`)
  if (method !== 'GET') headers.set('origin', ORIGIN)
  const workspace = init.workspace === undefined ? team.workspaceId : init.workspace
  if (workspace) headers.set('x-workspace-id', workspace)
  let body: string | undefined
  if (init.body !== undefined) {
    body = JSON.stringify(init.body)
    headers.set('content-type', 'application/json')
  }
  return (handler as Handler)(new NextRequest(`${ORIGIN}${path}`, { method, headers, body }), { params: Promise.resolve(init.params ?? {}) })
}

async function data<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

async function errorOf(res: Response | Promise<Response>): Promise<[number, string, string]> {
  const response = await res
  const body = (await response.json()) as { error?: { code?: string; message?: string } }
  return [response.status, body.error?.code ?? '', body.error?.message ?? '']
}

/** Enters the demo from a fresh address; returns the guest and their session cookie. */
async function enterDemo(): Promise<{ user: SessionUser; cookie: string }> {
  const res = await call(demoRoute.POST, '/api/auth/demo', { method: 'POST', workspace: null, ip: `198.51.100.${nextIp++}` })
  assert.equal(res.status, 201)
  const cookie = /corpus_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]
  assert.ok(cookie, 'a session cookie is set')
  return { user: (await data<{ user: SessionUser }>(res)).user, cookie }
}

async function ask(cookie: string, message: string, ip = '203.0.113.9') {
  const res = await call(chatRoute.POST, '/api/chat', { method: 'POST', cookie, ip, body: { message, collectionId: team.notebookId, mode: 'standard' } })
  if (res.status !== 200) return { status: res.status, events: [] as Array<Record<string, unknown>> }
  const events = (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  return { status: 200, events }
}

function configure(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetEnvCache()
}

before(async () => {
  configure({ AUTH_SECRET: SECRET, POSTGRES_URL: 'postgres://unused', APP_URL: undefined, TRUST_PROXY: '1', DEMO_DAILY_QUESTIONS: undefined })
  setJobAutorun(false)
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
  }
  setServicesForTests(services)
  const user = await createUser(repos, 'ada@example.com')
  ada = { ...user, cookie: await sessionToken(repos, user.user, SECRET) }
  team = await createTeam(repos, ada, [], 'Corpus demo')
  await addDocument(repos, {
    workspaceId: team.workspaceId,
    collectionId: team.notebookId,
    createdBy: ada.id,
    title: 'Photosynthesis notes',
    chunks: ['What photosynthesis does: photosynthesis converts light into chemical energy.'],
  })
  configure({ DEMO_WORKSPACE_ID: team.workspaceId })
})

beforeEach(async () => {
  // Every test starts with fresh allowances.
  await t.db.query('DELETE FROM app.rate_limits')
})

after(async () => {
  configure({ DEMO_WORKSPACE_ID: undefined, DEMO_DAILY_QUESTIONS: undefined, TRUST_PROXY: undefined })
  setServicesForTests(null)
  setJobAutorun(true)
  await t.close()
})

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe('public demo', () => {
  it('opens only for a configured team workspace', async () => {
    configure({ DEMO_WORKSPACE_ID: undefined })
    assert.equal(getDemoConfig(), null)
    assert.deepEqual((await errorOf(call(demoRoute.POST, '/api/auth/demo', { method: 'POST', workspace: null })))[0], 404)

    configure({ DEMO_WORKSPACE_ID: ada.workspaceId })
    assert.equal((await errorOf(call(demoRoute.POST, '/api/auth/demo', { method: 'POST', workspace: null })))[0], 404, "never someone's personal workspace")

    configure({ DEMO_WORKSPACE_ID: 'not-a-workspace-id' })
    assert.equal(getDemoConfig(), null)

    configure({ DEMO_WORKSPACE_ID: team.workspaceId })
    assert.deepEqual(getDemoConfig(), { workspaceId: team.workspaceId, dailyQuestions: 50 })
    const { user } = await enterDemo()
    assert.equal(user.guest, true)
    assert.ok(isGuestEmail(user.email))
    assert.equal(user.name, 'Demo visitor')
  })

  it('gives a guest the demo workspace only, read-only', async () => {
    const { user, cookie } = await enterDemo()
    assert.deepEqual((await data<{ user: SessionUser }>(call(authRoute.GET, '/api/auth', { cookie }))).user.guest, true)

    const { workspaces } = await data<{ workspaces: WorkspaceSummary[] }>(call(workspacesRoute.GET, '/api/workspaces', { cookie, workspace: null }))
    assert.deepEqual(
      workspaces.map((workspace) => [workspace.id, workspace.role]),
      [[team.workspaceId, 'viewer']],
      'no personal workspace to upload into',
    )
    const denied = await errorOf(call(workspacesRoute.POST, '/api/workspaces', { method: 'POST', cookie, workspace: null, body: { name: 'Mine' } }))
    assert.deepEqual(denied.slice(0, 2), [403, 'FORBIDDEN'])
    assert.match(denied[2], /read-only demo/)

    const upload = await errorOf(
      call(uploadsRoute.POST, '/api/learn/uploads', { method: 'POST', cookie, body: { collectionId: team.notebookId, fileName: 'notes.txt', byteSize: 10 } }),
    )
    assert.deepEqual(upload.slice(0, 2), [403, 'FORBIDDEN'])

    const own = await data<{ members: WorkspaceMember[] }>(call(membersRoute.GET, `/api/workspaces/${team.workspaceId}/members`, { cookie, params: { id: team.workspaceId } }))
    assert.deepEqual(
      own.members.map((member) => member.userId),
      [user.id],
      'guests see only themselves',
    )
    const admins = await data<{ members: WorkspaceMember[] }>(
      call(membersRoute.GET, `/api/workspaces/${team.workspaceId}/members`, { cookie: ada.cookie, params: { id: team.workspaceId } }),
    )
    assert.ok(
      admins.members.every((member) => !isGuestEmail(member.email)),
      'demo visitors do not crowd the member list',
    )
  })

  it('lets guests ask questions within the demo allowance, without follow-up model calls', async () => {
    configure({ DEMO_WORKSPACE_ID: team.workspaceId, DEMO_DAILY_QUESTIONS: '2' })
    const { cookie } = await enterDemo()
    const first = await ask(cookie, 'What does photosynthesis convert?')
    assert.equal(first.status, 200)
    const done = first.events.find((event) => event.type === 'done') as { assistantMessageId: string } | undefined
    assert.ok(done, 'the answer streamed to the end')

    const calls = ai.calls.complete.length
    const followups = await data<{ followups: string[] }>(
      call(followupsRoute.POST, `/api/messages/${done.assistantMessageId}/followups`, { method: 'POST', cookie, params: { id: done.assistantMessageId } }),
    )
    assert.deepEqual(followups.followups, [])
    assert.equal(ai.calls.complete.length, calls, 'no model call spent on suggestions')

    assert.equal((await ask(cookie, 'And what does it need?')).status, 200)
    const third = await call(chatRoute.POST, '/api/chat', { method: 'POST', cookie, ip: '203.0.113.9', body: { message: 'One more?', mode: 'standard' } })
    const [status, code, message] = await errorOf(third)
    assert.deepEqual([status, code], [429, 'DEMO_LIMIT'])
    assert.match(message, /today/)
    configure({ DEMO_DAILY_QUESTIONS: undefined })
  })

  it('limits questions and new guests per address', async () => {
    for (let i = 0; i < 15; i++) await enforceDemoQuestionLimits(repos, '192.0.2.50')
    await assert.rejects(enforceDemoQuestionLimits(repos, '192.0.2.50'), (error: { status?: number; code?: string }) => error.status === 429 && error.code === 'DEMO_LIMIT')
    await enforceDemoQuestionLimits(repos, '192.0.2.51')

    for (let i = 0; i < 10; i++) assert.equal((await call(demoRoute.POST, '/api/auth/demo', { method: 'POST', workspace: null, ip: '192.0.2.60' })).status, 201)
    assert.equal((await call(demoRoute.POST, '/api/auth/demo', { method: 'POST', workspace: null, ip: '192.0.2.60' })).status, 429)
  })

  it('removes guests after a day, with their chats and sessions', async () => {
    const { user, cookie } = await enterDemo()
    assert.equal((await ask(cookie, 'What does photosynthesis convert?')).status, 200)
    await t.db.query(`UPDATE app.users SET created_at = now() - interval '25 hours' WHERE id = $1`, [user.id])
    assert.ok((await purgeGuests(repos)) >= 1)
    const [row] = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.conversations WHERE owner_id = $1', [user.id])
    assert.equal(row?.n, 0)
    clearSessionCacheForTests() // sessions confirmed active are trusted for 30 s
    assert.equal((await call(authRoute.GET, '/api/auth', { cookie })).status, 401)
    assert.ok(await repos.users.findById(ada.id), 'real accounts are never touched')
  })

  it('keeps the demo page and its images public, and nothing else', () => {
    for (const path of ['/demo', '/api/auth/demo', '/demo/chat.webp', '/demo/architecture.webp']) assert.equal(isPublicPath(path), true, path)
    for (const path of ['/demo/chat.png', '/demo/../api/stats', '/demo/', '/api/auth/demo/x']) assert.equal(isPublicPath(path), false, path)
  })
})
