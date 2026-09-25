import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as conversationRoute from '@/app/api/conversations/[id]/route'
import * as conversationsRoute from '@/app/api/conversations/route'
import * as documentRetryRoute from '@/app/api/corpus/documents/[id]/retry/route'
import * as documentRoute from '@/app/api/corpus/documents/[id]/route'
import * as corpusRoute from '@/app/api/corpus/route'
import * as evaluationsRoute from '@/app/api/evaluations/route'
import * as imageFileRoute from '@/app/api/images/[id]/file/route'
import * as imageRoute from '@/app/api/images/[id]/route'
import * as imagesRoute from '@/app/api/images/route'
import * as uploadRoute from '@/app/api/learn/upload/route'
import * as feedbackRoute from '@/app/api/messages/[id]/feedback/route'
import * as notificationsReadRoute from '@/app/api/notifications/read/route'
import * as notificationsRoute from '@/app/api/notifications/route'
import * as statsRoute from '@/app/api/stats/route'
import * as auditRoute from '@/app/api/workspaces/[id]/audit/route'
import type { AuditEvent, DocumentDetail, DocumentSummary, ImageDetail, ImageSummary, NotificationItem, QualitySummary, StatsResponse, UploadResult } from '@/lib/contracts'
import { SESSION_COOKIE } from '@/server/auth/session'
import { resetEnvCache } from '@/server/env'
import { runJobs } from '@/server/jobs/runner'
import { setJobAutorun } from '@/server/jobs/trigger'
import { registryOf } from '@/server/connectors/registry'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { setServicesForTests, type Services } from '@/server/services'

import { createTestDb, type TestDb } from './helpers/db'
import { TINY_PNG, createFakeAi, createFakeImages, type FakeAi, type FakeImages } from './helpers/fake-ai'
import { createTeam, createUser, type TestUser } from './helpers/fixtures'
import { sessionToken } from './helpers/session'

const SECRET = 'p'.repeat(48)
const ORIGIN = 'http://localhost:3000'
let t: TestDb
let repos: Repositories
let ai: FakeAi
let images: FakeImages
let services: Services

interface Actor extends TestUser {
  cookie: string
}
let ada: Actor // team admin
let val: Actor // team viewer
let ed: Actor // team editor
let out: Actor // not in the team
let team: { workspaceId: string; notebookId: string }

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

function call(
  handler: unknown,
  path: string,
  init: { method?: string; as?: Actor; workspace?: string | null; body?: unknown; form?: FormData; params?: Record<string, string> } = {},
) {
  const headers = new Headers({ host: 'localhost:3000' })
  if (init.as) headers.set('cookie', `${SESSION_COOKIE}=${init.as.cookie}`)
  const method = init.method ?? 'GET'
  if (method !== 'GET') headers.set('origin', ORIGIN)
  const workspace = init.workspace === undefined ? team.workspaceId : init.workspace
  if (workspace) headers.set('x-workspace-id', workspace)
  let body: BodyInit | undefined
  if (init.form) body = init.form
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body)
    headers.set('content-type', 'application/json')
  }
  return (handler as Handler)(new NextRequest(`${ORIGIN}${path}`, { method, headers, body }), { params: Promise.resolve(init.params ?? {}) })
}

async function data<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

const jobs = () => runJobs({ repos, ai: () => ai, reranker: () => createLlmReranker(ai), images: () => images }, { maxJobs: 20 })

async function actor(email: string): Promise<Actor> {
  const user = await createUser(repos, email)
  return { ...user, cookie: await sessionToken(repos, user.user, SECRET) }
}

before(async () => {
  process.env.AUTH_SECRET = SECRET
  process.env.POSTGRES_URL = 'postgres://unused'
  resetEnvCache()
  setJobAutorun(false)
  t = await createTestDb()
  repos = createRepositories(t.db)
  ai = createFakeAi()
  images = createFakeImages()
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
  ada = await actor('ada@example.com')
  val = await actor('val@example.com')
  ed = await actor('ed@example.com')
  out = await actor('out@example.com')
  team = await createTeam(repos, ada, [
    [val, 'viewer'],
    [ed, 'editor'],
  ])
})

after(async () => {
  setServicesForTests(null)
  setJobAutorun(true)
  await t.close()
})

describe('file upload and background indexing', () => {
  let documentId: string

  it('accepts a file, answers 202 with a processing document and indexes it in the background', async () => {
    const form = new FormData()
    form.set('collectionId', team.notebookId)
    form.append('files', new File(['The observatory opens at dusk and closes at dawn.\n\nTelescopes are calibrated weekly.'], 'observatory.txt', { type: 'text/plain' }))
    const res = await call(uploadRoute.POST, '/api/learn/upload', { method: 'POST', as: ed, form })
    assert.equal(res.status, 202)
    const { results } = await data<UploadResult>(res)
    assert.equal(results[0]?.status, 'queued')
    assert.equal(results[0]?.document?.status, 'processing')
    assert.ok((results[0]?.document?.byteSize ?? 0) > 50)
    documentId = results[0]!.document!.id

    await jobs()
    const { documents } = await data<{ documents: DocumentSummary[] }>(call(corpusRoute.GET, `/api/corpus?collectionId=${team.notebookId}`, { as: val }))
    const indexed = documents.find((document) => document.id === documentId)
    assert.equal(indexed?.status, 'ready')
    assert.equal(indexed?.chunkCount, indexed?.totalChunks)
  })

  it('reports unreadable files per file with a reason (422 when nothing was accepted)', async () => {
    const form = new FormData()
    form.set('collectionId', team.notebookId)
    form.append('files', new File(['%PDF-not really'], 'broken.pdf', { type: 'application/pdf' }))
    form.append('files', new File(['binary'], 'program.exe'))
    const res = await call(uploadRoute.POST, '/api/learn/upload', { method: 'POST', as: ed, form })
    assert.equal(res.status, 422)
    const { results } = await data<UploadResult>(res)
    assert.deepEqual(
      results.map((result) => result.status),
      ['error', 'error'],
    )
    assert.match(results[1]!.error!, /not a supported file type/)
  })

  it('viewers cannot upload', async () => {
    const form = new FormData()
    form.set('collectionId', team.notebookId)
    form.append('files', new File(['text'], 'a.txt'))
    assert.equal((await call(uploadRoute.POST, '/api/learn/upload', { method: 'POST', as: val, form })).status, 403)
  })

  it('reads a whole document for the source viewer, only inside its workspace', async () => {
    const detail = await data<DocumentDetail>(call(documentRoute.GET, `/api/corpus/documents/${documentId}`, { as: val, params: { id: documentId } }))
    assert.equal(detail.document.title, 'observatory.txt')
    assert.match(detail.chunks.map((chunk) => chunk.content).join('\n'), /observatory opens at dusk/)
    const foreign = await call(documentRoute.GET, `/api/corpus/documents/${documentId}`, { as: out, workspace: out.workspaceId, params: { id: documentId } })
    assert.equal(foreign.status, 404)
  })

  it('retry is only for documents whose indexing failed', async () => {
    const res = await call(documentRetryRoute.POST, `/api/corpus/documents/${documentId}/retry`, { method: 'POST', as: ed, params: { id: documentId } })
    assert.equal(res.status, 409)
    assert.equal((await call(documentRetryRoute.POST, `/api/corpus/documents/${documentId}/retry`, { method: 'POST', as: val, params: { id: documentId } })).status, 403)
  })
})

describe('images API', () => {
  let imageId: string

  it('any member can queue an image grounded in the knowledge base (202)', async () => {
    const res = await call(imagesRoute.POST, '/api/images', {
      method: 'POST',
      as: val,
      body: { prompt: 'The observatory opens at dusk and closes at dawn', style: 'diagram', aspectRatio: '4:3', collectionId: team.notebookId },
    })
    assert.equal(res.status, 202)
    const { image } = await data<{ image: ImageSummary }>(res)
    assert.equal(image.status, 'queued')
    assert.equal(image.style, 'diagram')
    imageId = image.id

    await jobs()
    const { image: detail } = await data<{ image: ImageDetail }>(call(imageRoute.GET, `/api/images/${imageId}`, { as: ed, params: { id: imageId } }))
    assert.equal(detail.status, 'completed')
    assert.equal(detail.aspectRatio, '4:3')
    assert.ok(detail.sources.some((source) => source.title === 'observatory.txt'))
    assert.match(detail.finalPrompt!, /observatory opens at dusk/)
    const { images: listed } = await data<{ images: ImageSummary[] }>(call(imagesRoute.GET, '/api/images', { as: ed }))
    assert.equal(listed[0]?.id, imageId)
  })

  it('serves the bytes to members only (404 for everyone else), inline or as a download', async () => {
    const res = await call(imageFileRoute.GET, `/api/images/${imageId}/file`, { as: val, workspace: null, params: { id: imageId } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(res.headers.get('content-disposition') ?? '', /^inline; filename="grounded-picture\.png"$/)
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), TINY_PNG)

    const download = await call(imageFileRoute.GET, `/api/images/${imageId}/file?download=1`, { as: ed, workspace: null, params: { id: imageId } })
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/)
    assert.equal((await call(imageFileRoute.GET, `/api/images/${imageId}/file`, { as: out, workspace: null, params: { id: imageId } })).status, 404)
    assert.equal((await call(imageFileRoute.GET, `/api/images/${imageId}/file`, { workspace: null, params: { id: imageId } })).status, 401)
  })

  it('validates requests and reports when image generation is not configured', async () => {
    const invalid = await call(imagesRoute.POST, '/api/images', { method: 'POST', as: val, body: { prompt: 'x', style: 'oil-painting' } })
    assert.equal(invalid.status, 400)
    const foreignDocuments = await call(imagesRoute.POST, '/api/images', {
      method: 'POST',
      as: val,
      body: { prompt: 'Draw it', documentIds: ['00000000-0000-4000-8000-000000000000'] },
    })
    assert.equal(foreignDocuments.status, 400)
    setServicesForTests({ ...services, images: () => null })
    try {
      assert.equal((await call(imagesRoute.POST, '/api/images', { method: 'POST', as: val, body: { prompt: 'Draw it' } })).status, 503)
      const stats = await data<StatsResponse>(call(statsRoute.GET, '/api/stats', { as: val }))
      assert.equal(typeof stats.features.images, 'boolean')
    } finally {
      setServicesForTests(services)
    }
  })

  it('only the author or an admin can delete an image', async () => {
    assert.equal((await call(imageRoute.DELETE, `/api/images/${imageId}`, { method: 'DELETE', as: ed, params: { id: imageId } })).status, 403)
    assert.equal((await call(imageRoute.DELETE, `/api/images/${imageId}`, { method: 'DELETE', as: ada, params: { id: imageId } })).status, 200)
    assert.equal((await call(imageRoute.GET, `/api/images/${imageId}`, { as: ada, params: { id: imageId } })).status, 404)
  })
})

describe('feedback, notifications, audit and pins', () => {
  let answerId: string
  let questionId: string
  let conversationId: string

  before(async () => {
    const conversation = await repos.conversations.create({ workspaceId: team.workspaceId, ownerId: ed.id, collectionId: null, title: 'Opening hours' })
    conversationId = conversation.id
    questionId = (await repos.conversations.addMessage({ conversationId, role: 'user', content: 'When does it open?' })).id
    answerId = (await repos.conversations.addMessage({ conversationId, role: 'assistant', content: 'At dusk [1].' })).id
  })

  it('lets the author rate an answer, change it, and clear it', async () => {
    const path = `/api/messages/${answerId}/feedback`
    const up = await call(feedbackRoute.PUT, path, { method: 'PUT', as: ed, params: { id: answerId }, body: { rating: -1, comment: 'Missing the closing time' } })
    assert.deepEqual(await data(up), { feedback: { rating: -1, comment: 'Missing the closing time' } })
    const quality = await data<QualitySummary>(call(evaluationsRoute.GET, '/api/evaluations', { as: ada }))
    assert.equal(quality.feedback.negative, 1)
    assert.equal(quality.feedback.recent[0]?.question, 'When does it open?')
    const viewerQuality = await data<QualitySummary>(call(evaluationsRoute.GET, '/api/evaluations', { as: val }))
    assert.equal(viewerQuality.feedback.negative, 0, 'members only see their own feedback')

    const conversation = await data<{ messages: Array<{ id: string; feedback?: unknown }> }>(
      call(conversationRoute.GET, `/api/conversations/${conversationId}`, { as: ed, params: { id: conversationId } }),
    )
    assert.deepEqual(conversation.messages.find((message) => message.id === answerId)?.feedback, { rating: -1, comment: 'Missing the closing time' })

    assert.deepEqual(await data(call(feedbackRoute.PUT, path, { method: 'PUT', as: ed, params: { id: answerId }, body: { rating: 0 } })), { feedback: null })
    assert.equal((await call(feedbackRoute.PUT, path, { method: 'PUT', as: ed, params: { id: answerId }, body: { rating: 2 } })).status, 400)
  })

  it('refuses ratings on other people’s answers and on questions', async () => {
    assert.equal((await call(feedbackRoute.PUT, `/api/messages/${answerId}/feedback`, { method: 'PUT', as: ada, params: { id: answerId }, body: { rating: 1 } })).status, 404)
    assert.equal((await call(feedbackRoute.PUT, `/api/messages/${questionId}/feedback`, { method: 'PUT', as: ed, params: { id: questionId }, body: { rating: 1 } })).status, 404)
  })

  it('pins conversations for their author', async () => {
    await repos.conversations.create({ workspaceId: team.workspaceId, ownerId: ed.id, collectionId: null, title: 'Newer thread' })
    const pinned = await call(conversationRoute.PATCH, `/api/conversations/${conversationId}`, { method: 'PATCH', as: ed, params: { id: conversationId }, body: { pinned: true } })
    assert.equal(pinned.status, 200)
    const { conversations } = await data<{ conversations: Array<{ id: string; pinned: boolean }> }>(call(conversationsRoute.GET, '/api/conversations', { as: ed }))
    assert.deepEqual([conversations[0]?.id, conversations[0]?.pinned], [conversationId, true])
    assert.equal(
      (await call(conversationRoute.PATCH, `/api/conversations/${conversationId}`, { method: 'PATCH', as: ada, params: { id: conversationId }, body: { pinned: true } })).status,
      404,
    )
    assert.equal((await call(conversationRoute.PATCH, `/api/conversations/${conversationId}`, { method: 'PATCH', as: ed, params: { id: conversationId }, body: {} })).status, 400)
  })

  it('searches the caller’s own chats with ?q=', async () => {
    const search = (as: Actor, q: string) => call(conversationsRoute.GET, `/api/conversations?q=${encodeURIComponent(q)}`, { as })
    const own = await data<{ conversations: Array<{ id: string }> }>(search(ed, 'dusk'))
    assert.deepEqual(
      own.conversations.map((c) => c.id),
      [conversationId],
    )
    const other = await data<{ conversations: Array<{ id: string }> }>(search(ada, 'dusk'))
    assert.deepEqual(other.conversations, [], 'chats stay private to their author')
    assert.equal((await search(ed, 'x'.repeat(201))).status, 400)
  })

  it('lists notifications across workspaces and marks them read', async () => {
    const before = await data<{ items: NotificationItem[]; unread: number }>(call(notificationsRoute.GET, '/api/notifications', { as: val, workspace: null }))
    assert.ok(before.items.some((item) => item.kind === 'image_ready' && item.workspaceName === 'Team'))
    assert.ok(before.unread >= 1)
    const read = await data<{ updated: number }>(call(notificationsReadRoute.POST, '/api/notifications/read', { method: 'POST', as: val, workspace: null, body: { all: true } }))
    assert.equal(read.updated, before.unread)
    assert.equal((await data<{ unread: number }>(call(notificationsRoute.GET, '/api/notifications', { as: val, workspace: null }))).unread, 0)
    assert.equal((await call(notificationsReadRoute.POST, '/api/notifications/read', { method: 'POST', as: val, workspace: null, body: {} })).status, 400)
  })

  it('shows the audit log to workspace admins only', async () => {
    const path = `/api/workspaces/${team.workspaceId}/audit`
    const { events } = await data<{ events: AuditEvent[] }>(call(auditRoute.GET, path, { as: ada, workspace: null, params: { id: team.workspaceId } }))
    const actions = events.map((event) => event.action)
    for (const action of ['source.added', 'image.created', 'image.deleted']) assert.ok(actions.includes(action), action)
    assert.equal(events.find((event) => event.action === 'image.deleted')?.actorEmail, 'ada@example.com')
    assert.equal((await call(auditRoute.GET, path, { as: ed, workspace: null, params: { id: team.workspaceId } })).status, 403)
    assert.equal((await call(auditRoute.GET, path, { as: out, workspace: null, params: { id: team.workspaceId } })).status, 404)
  })
})
