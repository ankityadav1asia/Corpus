import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as analyticsRoute from '@/app/api/analytics/route'
import * as chatRoute from '@/app/api/chat/route'
import * as collectionRolesRoute from '@/app/api/collections/[id]/roles/route'
import * as collectionRoute from '@/app/api/collections/[id]/route'
import * as collectionsRoute from '@/app/api/collections/route'
import * as conversationRoute from '@/app/api/conversations/[id]/route'
import * as chunkRoute from '@/app/api/corpus/chunks/[id]/route'
import * as chunksRoute from '@/app/api/corpus/chunks/route'
import * as documentChunksRoute from '@/app/api/corpus/documents/[id]/chunks/route'
import * as corpusRoute from '@/app/api/corpus/route'
import * as evalCasesRoute from '@/app/api/evaluations/cases/route'
import * as evaluationsRoute from '@/app/api/evaluations/route'
import * as evalRunsRoute from '@/app/api/evaluations/runs/route'
import * as healthRoute from '@/app/api/health/route'
import * as jobsRunRoute from '@/app/api/jobs/run/route'
import * as learnRoute from '@/app/api/learn/route'
import * as learnUrlRoute from '@/app/api/learn/url/route'
import * as reportRoute from '@/app/api/reports/[id]/route'
import * as reportsRoute from '@/app/api/reports/route'
import * as statsRoute from '@/app/api/stats/route'
import * as memberRoute from '@/app/api/workspaces/[id]/members/[userId]/route'
import * as membersRoute from '@/app/api/workspaces/[id]/members/route'
import * as workspaceRoute from '@/app/api/workspaces/[id]/route'
import * as workspacesRoute from '@/app/api/workspaces/route'
import type { ChunkPage, Collection, ReportDetail, WorkspaceDetail, WorkspaceSummary } from '@/lib/contracts'
import type { ChatStreamEvent } from '@/lib/stream-protocol'
import { middleware } from '@/middleware'
import { AiProviderError, DAILY_QUOTA_MESSAGE } from '@/server/ai/provider'
import { SESSION_COOKIE, createSessionToken } from '@/server/auth/session'
import { resetEnvCache } from '@/server/env'
import { errorResponse } from '@/server/http/route'
import { runJobs } from '@/server/jobs/runner'
import { setJobAutorun } from '@/server/jobs/trigger'
import { registryOf } from '@/server/connectors/registry'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { setServicesForTests, type Services } from '@/server/services'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, createFakeImages, type FakeAi, type FakeImages } from './helpers/fake-ai'
import { createTeam, createUser, type TestUser } from './helpers/fixtures'
import { sessionToken } from './helpers/session'

const SECRET = 'y'.repeat(48)
const ORIGIN = 'http://localhost:3000'
let t: TestDb
let ai: FakeAi
let images: FakeImages
let repos: Repositories
let services: Services

interface Actor extends TestUser {
  cookie: string
}
let alice: Actor
let bob: Actor
let vera: Actor // viewer in the team
let eddie: Actor // editor in the team
let team: { workspaceId: string; notebookId: string }

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

interface CallOptions {
  method?: string
  as?: Actor
  cookie?: string
  workspace?: string
  body?: unknown
  origin?: string
  contentType?: string
  params?: Record<string, string>
  headers?: Record<string, string>
}

function call(handler: unknown, path: string, init: CallOptions = {}) {
  const headers = new Headers({ host: 'localhost:3000', ...init.headers })
  const cookie = init.cookie ?? init.as?.cookie
  if (cookie) headers.set('cookie', `${SESSION_COOKIE}=${cookie}`)
  const method = init.method ?? 'GET'
  const origin = init.origin ?? (method === 'GET' ? undefined : ORIGIN)
  if (origin !== undefined) headers.set('origin', origin)
  const workspace = init.workspace ?? init.as?.workspaceId
  if (workspace) headers.set('x-workspace-id', workspace)
  let body: string | undefined
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
    headers.set('content-type', init.contentType ?? 'application/json')
  }
  const req = new NextRequest(`${ORIGIN}${path}`, { method, headers, body })
  return (handler as Handler)(req, { params: Promise.resolve(init.params ?? {}) })
}

/** Sources are indexed by a background job; tests run it explicitly. */
async function indexQueued() {
  await runJobs({ repos, ai: () => ai, reranker: () => null, images: () => images }, { types: ['ingest_document'], maxJobs: 20 })
}

async function data<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

async function actor(email: string, name: string | null = null): Promise<Actor> {
  const user = await createUser(repos, email, name)
  return { ...user, cookie: await sessionToken(repos, user.user, SECRET) }
}

before(async () => {
  process.env.AUTH_SECRET = SECRET
  process.env.POSTGRES_URL = 'postgres://unused'
  delete process.env.CRON_SECRET
  resetEnvCache()
  setJobAutorun(false)
  t = await createTestDb()
  ai = createFakeAi()
  images = createFakeImages()
  repos = createRepositories(t.db)
  services = {
    db: t.db,
    repos,
    ai: () => ai,
    reranker: () => createLlmReranker(ai),
    images: () => images,
    vision: () => null,
    transcriber: () => null,
    speech: () => null,
    ocr: () => null,
    connectors: () => registryOf({}),
    email: () => null,
  }
  setServicesForTests(services)

  alice = await actor('alice@example.com', 'Alice')
  bob = await actor('bob@example.com', 'Bob')
  vera = await actor('vera@example.com', 'Vera')
  eddie = await actor('eddie@example.com', 'Eddie')
  team = await createTeam(repos, alice, [
    [vera, 'viewer'],
    [eddie, 'editor'],
  ])
})

after(async () => {
  setServicesForTests(null)
  setJobAutorun(true)
  await t.close()
})

describe('authentication', () => {
  it('rejects anonymous and forged sessions on every protected route handler', async () => {
    const forged = await createSessionToken({ id: 'session-x', user: { id: 'x', email: 'x@x.x', name: null } }, 'a-key-the-server-does-not-know-0123456789')
    for (const cookie of [undefined, forged, 'garbage']) {
      assert.equal((await call(collectionsRoute.GET, '/api/collections', { cookie, workspace: alice.workspaceId })).status, 401)
      assert.equal((await call(corpusRoute.DELETE, `/api/corpus?collectionId=${alice.notebookId}`, { method: 'DELETE', cookie, workspace: alice.workspaceId })).status, 401)
      assert.equal((await call(workspacesRoute.GET, '/api/workspaces', { cookie })).status, 401)
    }
  })

  it('middleware blocks what the old one let through, and redirects pages to /login', async () => {
    const api = await middleware(new NextRequest(`${ORIGIN}/api/corpus`, { method: 'DELETE' }))
    assert.equal(api.status, 401)
    const page = await middleware(new NextRequest(`${ORIGIN}/`))
    assert.equal(page.status, 307)
    assert.equal(new URL(page.headers.get('location')!).pathname, '/login')
    const deep = await middleware(new NextRequest(`${ORIGIN}/some/page?x=1`))
    assert.equal(new URL(deep.headers.get('location')!).searchParams.get('next'), '/some/page?x=1')
    const signedIn = await middleware(new NextRequest(`${ORIGIN}/api/corpus`, { headers: { cookie: `${SESSION_COOKIE}=${alice.cookie}` } }))
    assert.equal(signedIn.headers.get('x-middleware-next'), '1')
    for (const path of ['/api/health', '/api/jobs/run']) {
      assert.equal((await middleware(new NextRequest(`${ORIGIN}${path}`))).headers.get('x-middleware-next'), '1', path)
    }
  })
})

describe('request hardening', () => {
  it('blocks cross-site writes (CSRF) but allows same-origin ones', async () => {
    const evil = await call(collectionsRoute.POST, '/api/collections', { method: 'POST', as: alice, origin: 'https://evil.example', body: { name: 'x' } })
    assert.equal(evil.status, 403)
    const ok = await call(collectionsRoute.POST, '/api/collections', { method: 'POST', as: alice, body: { name: 'Work' } })
    assert.equal(ok.status, 201)
    assert.equal((await data<{ collection: Collection }>(ok)).collection.myRole, 'admin')
  })

  it('validates content type, JSON syntax, schema and body size', async () => {
    const base = { method: 'POST', as: alice }
    assert.equal((await call(collectionsRoute.POST, '/api/collections', { ...base, body: 'name=x', contentType: 'text/plain' })).status, 415)
    assert.equal((await call(collectionsRoute.POST, '/api/collections', { ...base, body: '{"name":' })).status, 400)
    const invalid = await call(collectionsRoute.POST, '/api/collections', { ...base, body: { name: '' } })
    assert.equal(invalid.status, 400)
    assert.equal((await data<{ error: { code: string } }>(invalid)).error.code, 'VALIDATION_FAILED')
    assert.equal((await call(collectionsRoute.POST, '/api/collections', { ...base, body: { name: 'x'.repeat(70_000) } })).status, 413)
  })

  it('never returns internal error details to the client', async () => {
    const broken: Services = {
      ...services,
      repos: {
        ...services.repos,
        collections: {
          ...services.repos.collections,
          list: async () => {
            throw new Error('connection string postgres://admin:hunter2@db')
          },
        },
      },
    }
    setServicesForTests(broken)
    try {
      const res = await call(collectionsRoute.GET, '/api/collections', { as: alice })
      assert.equal(res.status, 500)
      const text = await res.text()
      assert.ok(!text.includes('hunter2') && !text.includes('postgres://'))
      assert.match(text, /requestId/)
    } finally {
      setServicesForTests(services)
    }
  })

  it('turns AI vendor failures into a clear 429 / 503 without vendor details', async () => {
    const daily = errorResponse(new AiProviderError('Gemini request failed (429) project 1234', 429, false, 48, true), 'req-daily')
    assert.equal(daily.status, 429)
    const body = await data<{ error: { code: string; message: string; requestId: string } }>(daily)
    assert.deepEqual(body.error, { code: 'AI_RATE_LIMITED', message: DAILY_QUOTA_MESSAGE, requestId: 'req-daily' })
    const down = errorResponse(new AiProviderError('Gemini request failed (503)', 503, true), 'req-down')
    assert.equal(down.status, 503)
    assert.equal((await data<{ error: { code: string } }>(down)).error.code, 'AI_UNAVAILABLE')
  })

  it('reports an un-migrated database clearly instead of a generic crash', async () => {
    const empty = await createTestDb({ migrate: false })
    setServicesForTests({ ...services, db: empty.db, repos: createRepositories(empty.db) })
    try {
      const res = await call(collectionsRoute.GET, '/api/collections', { as: alice })
      assert.equal(res.status, 503)
      assert.equal((await data<{ error: { code: string } }>(res)).error.code, 'SCHEMA_MISSING')
      const stats = await data<{ schema: { ready: boolean; version: number } }>(call(statsRoute.GET, '/api/stats', { as: alice }))
      assert.deepEqual(stats.schema.ready, false)
    } finally {
      setServicesForTests(services)
      await empty.close()
    }
  })
})

describe('workspace authorization middleware', () => {
  it('requires a valid workspace header and hides workspaces from non-members (404, not 403)', async () => {
    assert.equal((await call(collectionsRoute.GET, '/api/collections', { cookie: alice.cookie })).status, 400)
    assert.equal((await call(collectionsRoute.GET, '/api/collections', { cookie: alice.cookie, workspace: 'not-a-uuid' })).status, 400)
    const foreign = await call(collectionsRoute.GET, '/api/collections', { cookie: bob.cookie, workspace: alice.workspaceId })
    assert.equal(foreign.status, 404)
    assert.equal((await call(collectionsRoute.GET, '/api/collections', { cookie: bob.cookie, workspace: team.workspaceId })).status, 404)
  })

  it('applies the role matrix: viewers read, editors write content, admins manage', async () => {
    const asMember = (who: Actor) => ({ as: who, workspace: team.workspaceId })
    // Viewer
    assert.equal((await call(collectionsRoute.GET, '/api/collections', asMember(vera))).status, 200)
    const viewerCollections = await data<{ collections: Collection[] }>(call(collectionsRoute.GET, '/api/collections', asMember(vera)))
    assert.equal(viewerCollections.collections[0]?.myRole, 'viewer')
    assert.equal((await call(collectionsRoute.POST, '/api/collections', { ...asMember(vera), method: 'POST', body: { name: 'Nope' } })).status, 403)
    const viewerIngest = await call(learnRoute.POST, '/api/learn', { ...asMember(vera), method: 'POST', body: { collectionId: team.notebookId, text: 'viewer text' } })
    assert.equal(viewerIngest.status, 403)
    assert.equal(ai.calls.embedDocuments.length, 0, 'denied before any AI spend')
    // Editor
    const editorIngest = await call(learnRoute.POST, '/api/learn', {
      ...asMember(eddie),
      method: 'POST',
      body: { collectionId: team.notebookId, title: 'Team handbook', text: 'The team retrospective happens every second Friday.' },
    })
    assert.equal(editorIngest.status, 202)
    assert.equal((await data<{ document: { status: string } }>(editorIngest)).document.status, 'processing')
    await indexQueued()
    assert.equal((await call(collectionsRoute.POST, '/api/collections', { ...asMember(eddie), method: 'POST', body: { name: 'Specs' } })).status, 201)
    const editorDelete = await call(collectionRoute.DELETE, `/api/collections/${team.notebookId}`, { ...asMember(eddie), method: 'DELETE', params: { id: team.notebookId } })
    assert.equal(editorDelete.status, 403)
    const editorClear = await call(corpusRoute.DELETE, `/api/corpus?collectionId=${team.notebookId}`, { ...asMember(eddie), method: 'DELETE' })
    assert.equal(editorClear.status, 403)
    // Everyone in the workspace sees the shared knowledge base.
    const seen = await data<ChunkPage>(call(chunksRoute.GET, '/api/corpus/chunks?q=retrospective', asMember(vera)))
    assert.equal(seen.total, 1)
    const outsider = await call(chunksRoute.GET, '/api/corpus/chunks?q=retrospective', { as: bob, workspace: team.workspaceId })
    assert.equal(outsider.status, 404)
    const ownSpace = await data<ChunkPage>(call(chunksRoute.GET, '/api/corpus/chunks?q=retrospective', { as: bob }))
    assert.equal(ownSpace.total, 0)
  })

  it('notebook role overrides are managed by admins and change what a member may do', async () => {
    const asAdmin = { as: alice, workspace: team.workspaceId, params: { id: team.notebookId } }
    const promote = await call(collectionRolesRoute.PUT, `/api/collections/${team.notebookId}/roles`, { ...asAdmin, method: 'PUT', body: { userId: vera.id, role: 'editor' } })
    assert.equal(promote.status, 200)
    const roles = await data<{ roles: Array<{ userId: string; effectiveRole: string; override: string | null }> }>(
      call(collectionRolesRoute.GET, `/api/collections/${team.notebookId}/roles`, asAdmin),
    )
    assert.equal(roles.roles.find((r) => r.userId === vera.id)?.effectiveRole, 'editor')
    const veraIngest = await call(learnRoute.POST, '/api/learn', {
      as: vera,
      workspace: team.workspaceId,
      method: 'POST',
      body: { collectionId: team.notebookId, title: 'Vera notes', text: 'Vera can now add notes to this notebook.' },
    })
    assert.equal(veraIngest.status, 202)
    await indexQueued()
    const adminOverride = await call(collectionRolesRoute.PUT, `/api/collections/${team.notebookId}/roles`, {
      ...asAdmin,
      method: 'PUT',
      body: { userId: alice.id, role: 'viewer' },
    })
    assert.equal(adminOverride.status, 400)
    const byEditor = await call(collectionRolesRoute.PUT, `/api/collections/${team.notebookId}/roles`, {
      as: eddie,
      workspace: team.workspaceId,
      params: { id: team.notebookId },
      method: 'PUT',
      body: { userId: vera.id, role: 'admin' },
    })
    assert.equal(byEditor.status, 403)
    await call(collectionRolesRoute.PUT, `/api/collections/${team.notebookId}/roles`, { ...asAdmin, method: 'PUT', body: { userId: vera.id, role: null } })
  })
})

describe('data isolation (IDOR)', () => {
  it('another user cannot delete, clear or read a notebook outside their workspaces', async () => {
    for (const workspace of [bob.workspaceId, alice.workspaceId]) {
      const bobDelete = await call(collectionRoute.DELETE, `/api/collections/${alice.notebookId}`, { method: 'DELETE', as: bob, workspace, params: { id: alice.notebookId } })
      assert.equal(bobDelete.status, 404)
      const bobClear = await call(corpusRoute.DELETE, `/api/corpus?collectionId=${alice.notebookId}`, { method: 'DELETE', as: bob, workspace })
      assert.equal(bobClear.status, 404)
    }
    const noWipeAll = await call(corpusRoute.DELETE, '/api/corpus', { method: 'DELETE', as: alice })
    assert.equal(noWipeAll.status, 400, 'there is no "delete everything" endpoint anymore')
  })

  it('ingested text is visible inside its workspace only', async () => {
    const ingest = await call(learnRoute.POST, '/api/learn', {
      method: 'POST',
      as: alice,
      body: { collectionId: alice.notebookId, title: 'Secret plan', text: 'The quarterly launch codename is Bluebird.' },
    })
    assert.equal(ingest.status, 202)
    await indexQueued()
    const mine = await data<ChunkPage>(call(chunksRoute.GET, '/api/corpus/chunks?q=Bluebird', { as: alice }))
    const theirs = await data<ChunkPage>(call(chunksRoute.GET, '/api/corpus/chunks?q=Bluebird', { as: bob }))
    assert.equal(mine.total, 1)
    assert.equal(theirs.total, 0)
    const bobIngest = await call(learnRoute.POST, '/api/learn', { method: 'POST', as: bob, body: { collectionId: alice.notebookId, text: 'inject' } })
    assert.equal(bobIngest.status, 404)
  })
})

describe('chunk editor API', () => {
  it('shows chunk details and lets editors (not viewers) edit, add and delete chunks', async () => {
    const page = await data<ChunkPage>(call(chunksRoute.GET, `/api/corpus/chunks?collectionId=${team.notebookId}&q=retrospective`, { as: vera, workspace: team.workspaceId }))
    const chunk = page.items[0]!
    const detail = await data<{ chunk: { embedding: { dimensions: number } } }>(
      call(chunkRoute.GET, `/api/corpus/chunks/${chunk.id}`, { as: vera, workspace: team.workspaceId, params: { id: chunk.id } }),
    )
    assert.equal(detail.chunk.embedding.dimensions, 3072)

    const edit = (who: Actor, body: unknown) =>
      call(chunkRoute.PATCH, `/api/corpus/chunks/${chunk.id}`, { as: who, workspace: team.workspaceId, method: 'PATCH', params: { id: chunk.id }, body })
    assert.equal((await edit(vera, { labels: ['x'] })).status, 403)
    assert.equal((await edit(eddie, {})).status, 400, 'empty edits are rejected')
    assert.equal((await edit(eddie, { labels: ['Bad<label>'] })).status, 400)
    const updated = await edit(eddie, {
      content: 'The team retrospective happens every Friday afternoon.',
      labels: ['Process', 'process', 'rituals'],
      metadata: { owner: 'eddie' },
    })
    assert.equal(updated.status, 200)
    const body = await data<{ chunk: { labels: string[]; metadata: Record<string, unknown>; content: string } }>(updated)
    assert.deepEqual(body.chunk.labels, ['process', 'rituals'])
    assert.deepEqual(body.chunk.metadata, { owner: 'eddie' })
    const byLabel = await data<ChunkPage>(call(chunksRoute.GET, '/api/corpus/chunks?label=rituals', { as: vera, workspace: team.workspaceId }))
    assert.equal(byLabel.total, 1)

    const added = await call(documentChunksRoute.POST, `/api/corpus/documents/${chunk.documentId}/chunks`, {
      as: eddie,
      workspace: team.workspaceId,
      method: 'POST',
      params: { id: chunk.documentId },
      body: { content: 'A hand-written note appended by an editor.' },
    })
    assert.equal(added.status, 201)
    const addedId = (await data<{ chunk: { id: string } }>(added)).chunk.id
    const removed = await call(chunkRoute.DELETE, `/api/corpus/chunks/${addedId}`, { as: eddie, workspace: team.workspaceId, method: 'DELETE', params: { id: addedId } })
    assert.equal(removed.status, 200)
    const foreign = await call(chunkRoute.GET, `/api/corpus/chunks/${chunk.id}`, { as: bob, params: { id: chunk.id } })
    assert.equal(foreign.status, 404)
  })
})

describe('chat over HTTP', () => {
  it('streams NDJSON progress events and keeps the conversation private to its author', async () => {
    const res = await call(chatRoute.POST, '/api/chat', { method: 'POST', as: alice, body: { message: 'What is the codename?', collectionId: alice.notebookId } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/)
    const events = (await res.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatStreamEvent)
    assert.deepEqual([...new Set(events.map((e) => e.type))], ['start', 'status', 'sources', 'delta', 'done'])
    const start = events[0] as Extract<ChatStreamEvent, { type: 'start' }>
    const sources = events.find((e) => e.type === 'sources') as Extract<ChatStreamEvent, { type: 'sources' }>
    assert.equal(sources.citations[0]?.title, 'Secret plan')

    const own = await call(conversationRoute.GET, `/api/conversations/${start.conversationId}`, { as: alice, params: { id: start.conversationId } })
    assert.equal(own.status, 200)
    const foreign = await call(conversationRoute.GET, `/api/conversations/${start.conversationId}`, { as: bob, params: { id: start.conversationId } })
    assert.equal(foreign.status, 404)

    const analytics = await data<{ totals: { queries: number } }>(call(analyticsRoute.GET, '/api/analytics', { as: alice }))
    assert.equal(analytics.totals.queries, 1)
  })

  it('answers unknown topics with the guardrail message instead of calling the model', async () => {
    const chatsBefore = ai.calls.chat.length
    const res = await call(chatRoute.POST, '/api/chat', { method: 'POST', as: alice, body: { message: 'Who won the football league yesterday?' } })
    const text = await res.text()
    assert.match(text, /Insufficient context in knowledge base\./)
    assert.equal(ai.calls.chat.length, chatsBefore)
  })

  it('rejects oversized questions before calling the model', async () => {
    const chatsBefore = ai.calls.chat.length
    const res = await call(chatRoute.POST, '/api/chat', { method: 'POST', as: alice, body: { message: 'x'.repeat(5000) } })
    assert.equal(res.status, 400)
    assert.equal(ai.calls.chat.length, chatsBefore)
  })

  it('workspace-wide analytics are for admins only', async () => {
    assert.equal((await call(analyticsRoute.GET, '/api/analytics?scope=workspace', { as: vera, workspace: team.workspaceId })).status, 403)
    assert.equal((await call(analyticsRoute.GET, '/api/analytics?scope=workspace', { as: alice, workspace: team.workspaceId })).status, 200)
  })
})

describe('workspaces and members API', () => {
  let created: WorkspaceSummary

  it('creates team workspaces with a default notebook and lists memberships', async () => {
    const res = await call(workspacesRoute.POST, '/api/workspaces', { method: 'POST', as: bob, body: { name: 'Bob’s team' } })
    assert.equal(res.status, 201)
    created = (await data<{ workspace: WorkspaceSummary }>(res)).workspace
    assert.equal(created.role, 'admin')
    const list = await data<{ workspaces: WorkspaceSummary[] }>(call(workspacesRoute.GET, '/api/workspaces', { as: bob }))
    assert.deepEqual(
      list.workspaces.map((w) => [w.isPersonal, w.role]),
      [
        [true, 'admin'],
        [false, 'admin'],
      ],
    )
    const collections = await data<{ collections: Collection[] }>(call(collectionsRoute.GET, '/api/collections', { as: bob, workspace: created.id }))
    assert.equal(collections.collections.length, 1)
  })

  it('adds existing users, invites unknown addresses, and only admins may do either', async () => {
    const path = `/api/workspaces/${created.id}/members`
    const params = { id: created.id }
    const added = await call(membersRoute.POST, path, { as: bob, method: 'POST', params, body: { email: 'Vera@Example.com', role: 'viewer' } })
    assert.equal(added.status, 201)
    assert.deepEqual(await data(added), { status: 'added' })
    assert.equal((await call(membersRoute.POST, path, { as: bob, method: 'POST', params, body: { email: 'vera@example.com', role: 'editor' } })).status, 409)
    const invited = await call(membersRoute.POST, path, { as: bob, method: 'POST', params, body: { email: 'future@example.com', role: 'editor' } })
    assert.deepEqual(await data(invited), { status: 'invited' })
    assert.equal((await call(membersRoute.POST, path, { as: vera, method: 'POST', params, body: { email: 'x@example.com', role: 'admin' } })).status, 403)
    const personal = await call(membersRoute.POST, `/api/workspaces/${bob.workspaceId}/members`, {
      as: bob,
      method: 'POST',
      params: { id: bob.workspaceId },
      body: { email: 'vera@example.com', role: 'viewer' },
    })
    assert.equal(personal.status, 400, 'personal workspaces cannot be shared')

    const asAdmin = await data<{ members: unknown[]; invites: unknown[] }>(call(membersRoute.GET, path, { as: bob, params }))
    const asViewer = await data<{ members: unknown[]; invites: unknown[] }>(call(membersRoute.GET, path, { as: vera, params }))
    assert.equal(asAdmin.members.length, 2)
    assert.equal(asAdmin.invites.length, 1)
    assert.equal(asViewer.invites.length, 0, 'pending invitations are visible to admins only')
    assert.equal((await call(membersRoute.GET, path, { as: eddie, params })).status, 404)
  })

  it('changes roles, protects the last admin and lets members leave', async () => {
    const memberPath = (userId: string) => `/api/workspaces/${created.id}/members/${userId}`
    const params = (userId: string) => ({ id: created.id, userId })
    const demoteSelf = await call(memberRoute.PATCH, memberPath(bob.id), { as: bob, method: 'PATCH', params: params(bob.id), body: { role: 'viewer' } })
    assert.equal(demoteSelf.status, 409)
    assert.equal((await call(memberRoute.PATCH, memberPath(vera.id), { as: vera, method: 'PATCH', params: params(vera.id), body: { role: 'admin' } })).status, 403)
    assert.equal((await call(memberRoute.PATCH, memberPath(vera.id), { as: bob, method: 'PATCH', params: params(vera.id), body: { role: 'editor' } })).status, 200)
    assert.equal((await call(memberRoute.DELETE, memberPath(bob.id), { as: bob, method: 'DELETE', params: params(bob.id) })).status, 409)
    assert.equal((await call(memberRoute.DELETE, memberPath(vera.id), { as: vera, method: 'DELETE', params: params(vera.id) })).status, 200, 'members can leave')
    assert.equal((await call(collectionsRoute.GET, '/api/collections', { as: vera, workspace: created.id })).status, 404)
  })

  it('admins change settings; others cannot; personal workspaces cannot be deleted', async () => {
    const patch = await call(workspaceRoute.PATCH, `/api/workspaces/${created.id}`, {
      as: bob,
      method: 'PATCH',
      params: { id: created.id },
      body: { name: 'Renamed', settings: { guardrail: { minRelevance: 0.5 }, retrieval: { topK: 3 } } },
    })
    assert.equal(patch.status, 200)
    const detail = (await data<{ workspace: WorkspaceDetail }>(patch)).workspace
    assert.equal(detail.name, 'Renamed')
    assert.equal(detail.settings.guardrail.minRelevance, 0.5)
    assert.equal(detail.settings.guardrail.minSimilarity, 0.45, 'untouched settings keep their values')
    assert.equal(detail.settings.retrieval.topK, 3)
    const invalid = await call(workspaceRoute.PATCH, `/api/workspaces/${created.id}`, {
      as: bob,
      method: 'PATCH',
      params: { id: created.id },
      body: { settings: { retrieval: { topK: 50 } } },
    })
    assert.equal(invalid.status, 400)
    const byEditor = await call(workspaceRoute.PATCH, `/api/workspaces/${team.workspaceId}`, {
      as: eddie,
      method: 'PATCH',
      params: { id: team.workspaceId },
      body: { name: 'Mine now' },
    })
    assert.equal(byEditor.status, 403)
    assert.equal((await call(workspaceRoute.DELETE, `/api/workspaces/${bob.workspaceId}`, { as: bob, method: 'DELETE', params: { id: bob.workspaceId } })).status, 400)
    assert.equal((await call(workspaceRoute.DELETE, `/api/workspaces/${created.id}`, { as: bob, method: 'DELETE', params: { id: created.id } })).status, 200)
  })
})

describe('reports API', () => {
  it('queues a report (202), generates it in the background and restricts deletion', async () => {
    const res = await call(reportsRoute.POST, '/api/reports', {
      as: vera,
      workspace: team.workspaceId,
      method: 'POST',
      body: { template: 'executive_summary', collectionIds: [team.notebookId] },
    })
    assert.equal(res.status, 202)
    const { report } = await data<{ report: ReportDetail }>(res)
    assert.equal(report.status, 'queued')
    assert.match(report.title, /Executive summary — \d+ documents?/)
    assert.equal((await call(reportsRoute.POST, '/api/reports', { as: vera, workspace: team.workspaceId, method: 'POST', body: { template: 'executive_summary' } })).status, 400)

    await runJobs({ repos, ai: () => ai, reranker: () => null, images: () => images })
    const detail = await data<{ report: ReportDetail }>(call(reportRoute.GET, `/api/reports/${report.id}`, { as: eddie, workspace: team.workspaceId, params: { id: report.id } }))
    assert.equal(detail.report.status, 'completed')
    assert.ok(detail.report.content)
    assert.equal((await call(reportRoute.GET, `/api/reports/${report.id}`, { as: bob, params: { id: report.id } })).status, 404)
    assert.equal((await call(reportRoute.DELETE, `/api/reports/${report.id}`, { as: eddie, workspace: team.workspaceId, method: 'DELETE', params: { id: report.id } })).status, 403)
    assert.equal((await call(reportRoute.DELETE, `/api/reports/${report.id}`, { as: alice, workspace: team.workspaceId, method: 'DELETE', params: { id: report.id } })).status, 200)
  })
})

describe('evaluation API', () => {
  it('editors manage benchmark questions and start one run at a time; members read the summary', async () => {
    const asTeam = (who: Actor) => ({ as: who, workspace: team.workspaceId })
    const question = { question: 'When is the retrospective?', referenceAnswer: 'Every Friday afternoon.' }
    assert.equal((await call(evalCasesRoute.POST, '/api/evaluations/cases', { ...asTeam(vera), method: 'POST', body: question })).status, 403)
    assert.equal((await call(evalCasesRoute.POST, '/api/evaluations/cases', { ...asTeam(eddie), method: 'POST', body: question })).status, 201)
    const started = await call(evalRunsRoute.POST, '/api/evaluations/runs', { ...asTeam(eddie), method: 'POST' })
    assert.equal(started.status, 202)
    assert.equal((await call(evalRunsRoute.POST, '/api/evaluations/runs', { ...asTeam(eddie), method: 'POST' })).status, 409)
    await runJobs({ repos, ai: () => ai, reranker: () => createLlmReranker(ai), images: () => images })
    const summary = await data<{ lastBenchmark: { status: string; averages: { contextRecall: number | null } } | null }>(
      call(evaluationsRoute.GET, '/api/evaluations', asTeam(vera)),
    )
    assert.equal(summary.lastBenchmark?.status, 'completed')
    assert.equal(summary.lastBenchmark?.averages.contextRecall, 1)
  })
})

describe('background job endpoint', () => {
  it('is disabled without CRON_SECRET and requires the exact bearer token', async () => {
    assert.equal((await call(jobsRunRoute.POST, '/api/jobs/run', { method: 'POST', headers: { authorization: 'Bearer anything' } })).status, 404)
    process.env.CRON_SECRET = 'c'.repeat(32)
    resetEnvCache()
    try {
      assert.equal((await call(jobsRunRoute.POST, '/api/jobs/run', { method: 'POST' })).status, 401)
      assert.equal((await call(jobsRunRoute.POST, '/api/jobs/run', { method: 'POST', headers: { authorization: `Bearer ${'c'.repeat(31)}x` } })).status, 401)
      const ok = await call(jobsRunRoute.GET, '/api/jobs/run', { headers: { authorization: `Bearer ${'c'.repeat(32)}` } })
      assert.equal(ok.status, 200)
      assert.deepEqual(Object.keys(await data(ok)).sort(), ['failed', 'processed'])
    } finally {
      delete process.env.CRON_SECRET
      resetEnvCache()
    }
  })
})

describe('URL ingestion (SSRF)', () => {
  it('refuses cloud-metadata and localhost URLs before any fetch or AI call', async () => {
    const embedsBefore = ai.calls.embedDocuments.length
    for (const url of ['http://169.254.169.254/latest/meta-data/iam/security-credentials/', 'http://localhost:8080/admin', 'file:///etc/passwd']) {
      const res = await call(learnUrlRoute.POST, '/api/learn/url', { method: 'POST', as: alice, body: { collectionId: alice.notebookId, url } })
      assert.equal(res.status, 400, url)
    }
    assert.equal(ai.calls.embedDocuments.length, embedsBefore)
  })
})

describe('health and stats', () => {
  it('health is public and reveals nothing but status', async () => {
    const res = await call(healthRoute.GET, '/api/health')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, database: 'up' })
  })

  it('stats report totals only for workspaces the caller belongs to', async () => {
    const mine = await data<{ totals: { documents: number } }>(call(statsRoute.GET, '/api/stats', { as: alice, workspace: team.workspaceId }))
    assert.ok(mine.totals.documents >= 1)
    const probe = await data<{ totals: { documents: number } }>(call(statsRoute.GET, '/api/stats', { as: bob, workspace: team.workspaceId }))
    assert.equal(probe.totals.documents, 0)
  })
})
