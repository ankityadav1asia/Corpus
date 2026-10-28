import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as chunkRoute from '@/app/api/corpus/chunks/[id]/route'
import * as chunksRoute from '@/app/api/corpus/chunks/route'
import * as documentChunksRoute from '@/app/api/corpus/documents/[id]/chunks/route'
import * as corpusRoute from '@/app/api/corpus/route'
import * as evalCasesRoute from '@/app/api/evaluations/cases/route'
import * as evaluationsRoute from '@/app/api/evaluations/route'
import * as evalRunsRoute from '@/app/api/evaluations/runs/route'
import * as jobsRunRoute from '@/app/api/jobs/run/route'
import * as learnRoute from '@/app/api/learn/route'
import * as learnUrlRoute from '@/app/api/learn/url/route'
import * as reportRoute from '@/app/api/reports/[id]/route'
import * as reportsRoute from '@/app/api/reports/route'
import * as statsRoute from '@/app/api/stats/route'
import type { ChunkPage, ReportDetail } from '@/lib/contracts'
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
      assert.equal((await call(chunksRoute.GET, '/api/corpus/chunks', { cookie, workspace: alice.workspaceId })).status, 401)
      assert.equal((await call(corpusRoute.DELETE, `/api/corpus?collectionId=${alice.notebookId}`, { method: 'DELETE', cookie, workspace: alice.workspaceId })).status, 401)
      assert.equal((await call(statsRoute.GET, '/api/stats', { cookie })).status, 401)
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
  // The Go API (backend/) has the same checks for the routes it serves (backend/api).
  // Checked on a TypeScript route with a JSON body: adding a benchmark question (32 KB limit).
  const path = '/api/evaluations/cases'
  const base = () => ({ method: 'POST', as: alice })

  it('blocks cross-site writes (CSRF) but allows same-origin ones', async () => {
    const question = { question: 'What is RRF?', referenceAnswer: 'Reciprocal Rank Fusion.' }
    const evil = await call(evalCasesRoute.POST, path, { ...base(), origin: 'https://evil.example', body: question })
    assert.equal(evil.status, 403)
    const ok = await call(evalCasesRoute.POST, path, { ...base(), body: question })
    assert.equal(ok.status, 201)
  })

  it('validates content type, JSON syntax, schema and body size', async () => {
    assert.equal((await call(evalCasesRoute.POST, path, { ...base(), body: 'question=x', contentType: 'text/plain' })).status, 415)
    assert.equal((await call(evalCasesRoute.POST, path, { ...base(), body: '{"question":' })).status, 400)
    const invalid = await call(evalCasesRoute.POST, path, { ...base(), body: { question: '', referenceAnswer: 'x' } })
    assert.equal(invalid.status, 400)
    assert.equal((await data<{ error: { code: string } }>(invalid)).error.code, 'VALIDATION_FAILED')
    assert.equal((await call(evalCasesRoute.POST, path, { ...base(), body: { question: 'x'.repeat(70_000), referenceAnswer: 'x' } })).status, 413)
  })

  it('never returns internal error details to the client', async () => {
    const broken: Services = {
      ...services,
      repos: {
        ...services.repos,
        documents: {
          ...services.repos.documents,
          list: async () => {
            throw new Error('connection string postgres://admin:hunter2@db')
          },
        },
      },
    }
    setServicesForTests(broken)
    try {
      const res = await call(corpusRoute.GET, '/api/corpus', { as: alice })
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
      const res = await call(corpusRoute.GET, '/api/corpus', { as: alice })
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
    assert.equal((await call(chunksRoute.GET, '/api/corpus/chunks', { cookie: alice.cookie })).status, 400)
    assert.equal((await call(chunksRoute.GET, '/api/corpus/chunks', { cookie: alice.cookie, workspace: 'not-a-uuid' })).status, 400)
    const foreign = await call(chunksRoute.GET, '/api/corpus/chunks', { cookie: bob.cookie, workspace: alice.workspaceId })
    assert.equal(foreign.status, 404)
    assert.equal((await call(chunksRoute.GET, '/api/corpus/chunks', { cookie: bob.cookie, workspace: team.workspaceId })).status, 404)
  })

  it('applies the role matrix: viewers read, editors write content, admins manage', async () => {
    const asMember = (who: Actor) => ({ as: who, workspace: team.workspaceId })
    // Viewer (notebook administration is the Go API's: backend/api)
    assert.equal((await call(chunksRoute.GET, '/api/corpus/chunks', asMember(vera))).status, 200)
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

  // Setting overrides is the Go API's (backend/api); this checks the TypeScript routes honour them.
  it('notebook role overrides change what a member may do', async () => {
    await repos.collections.setRoleOverride(team.notebookId, vera.id, 'editor')
    const veraIngest = await call(learnRoute.POST, '/api/learn', {
      as: vera,
      workspace: team.workspaceId,
      method: 'POST',
      body: { collectionId: team.notebookId, title: 'Vera notes', text: 'Vera can now add notes to this notebook.' },
    })
    assert.equal(veraIngest.status, 202)
    await indexQueued()
    await repos.collections.setRoleOverride(team.notebookId, vera.id, null)
    const veraAgain = await call(learnRoute.POST, '/api/learn', {
      as: vera,
      workspace: team.workspaceId,
      method: 'POST',
      body: { collectionId: team.notebookId, text: 'no longer' },
    })
    assert.equal(veraAgain.status, 403, 'without the override she is a viewer again')
  })
})

describe('data isolation (IDOR)', () => {
  it('another user cannot clear or read a notebook outside their workspaces', async () => {
    for (const workspace of [bob.workspaceId, alice.workspaceId]) {
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

describe('stats', () => {
  it('stats report totals only for workspaces the caller belongs to', async () => {
    const mine = await data<{ totals: { documents: number } }>(call(statsRoute.GET, '/api/stats', { as: alice, workspace: team.workspaceId }))
    assert.ok(mine.totals.documents >= 1)
    const probe = await data<{ totals: { documents: number } }>(call(statsRoute.GET, '/api/stats', { as: bob, workspace: team.workspaceId }))
    assert.equal(probe.totals.documents, 0)
  })
})
