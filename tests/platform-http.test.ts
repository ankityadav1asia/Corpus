import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as documentRetryRoute from '@/app/api/corpus/documents/[id]/retry/route'
import * as documentRoute from '@/app/api/corpus/documents/[id]/route'
import * as corpusRoute from '@/app/api/corpus/route'
import * as evaluationsRoute from '@/app/api/evaluations/route'
import * as uploadRoute from '@/app/api/learn/upload/route'
import type { AuditEvent, DocumentDetail, DocumentSummary, QualitySummary, UploadResult } from '@/lib/contracts'
import { SESSION_COOKIE } from '@/server/auth/session'
import { resetEnvCache } from '@/server/env'
import { runJobs } from '@/server/jobs/runner'
import { setJobAutorun } from '@/server/jobs/trigger'
import { registryOf } from '@/server/connectors/registry'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { setServicesForTests, type Services } from '@/server/services'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, type FakeAi } from './helpers/fake-ai'
import { createTeam, createUser, type TestUser } from './helpers/fixtures'
import { docx, pptx, xlsx } from './helpers/office'
import { sessionToken } from './helpers/session'

const SECRET = 'p'.repeat(48)
const ORIGIN = 'http://localhost:3000'
let t: TestDb
let repos: Repositories
let ai: FakeAi
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

const jobs = () => runJobs({ repos, ai: () => ai, reranker: () => createLlmReranker(ai) }, { maxJobs: 20 })

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
  services = {
    db: t.db,
    repos,
    ai: () => ai,
    reranker: () => createLlmReranker(ai),
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

  it('reads Word, PowerPoint and Excel files', async () => {
    const form = new FormData()
    form.set('collectionId', team.notebookId)
    form.append('files', new File([docx('<w:p><w:r><w:t>The greenhouse is watered at six.</w:t></w:r></w:p>')], 'greenhouse.docx'))
    form.append('files', new File([pptx([{ part: 'slide1.xml', text: ['Seed bank tour'], notes: ['Start at the cold room.'] }])], 'tour.pptx'))
    form.append('files', new File([xlsx([{ name: 'Beds', cells: { A1: 'Bed', B1: 'Crop', A2: 'North', B2: 'Kale' } }])], 'beds.xlsx'))
    form.append('files', new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])], 'locked.docx'))
    const res = await call(uploadRoute.POST, '/api/learn/upload', { method: 'POST', as: ed, form })
    assert.equal(res.status, 202)
    const { results } = await data<UploadResult>(res)
    assert.deepEqual(
      results.map((result) => result.status),
      ['queued', 'queued', 'queued', 'error'],
    )
    assert.match(results[3]!.error!, /password-protected or in the old binary format/)

    await jobs()
    const ids = results.slice(0, 3).map((result) => result.document!.id)
    const texts = await repos.documents.documentTexts(team.workspaceId, ids, 10_000)
    const byTitle = Object.fromEntries(texts.map((document) => [document.title, document.text]))
    assert.match(byTitle['greenhouse.docx'] ?? '', /The greenhouse is watered at six\./)
    assert.match(byTitle['tour.pptx'] ?? '', /## Slide 1\nSeed bank tour\n\nNotes: Start at the cold room\./)
    assert.match(byTitle['beds.xlsx'] ?? '', /## Sheet: Beds[\s\S]*Row 1: Bed: North \| Crop: Kale/)
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

  // Rating answers, pins, search and notifications are the Go API's (backend/api); the quality
  // summary that reads the ratings is still TypeScript.
  it('counts ratings in the quality summary, each member seeing their own', async () => {
    await repos.feedback.set({ messageId: answerId, userId: ed.id, workspaceId: team.workspaceId, rating: -1, comment: 'Missing the closing time' })
    const quality = await data<QualitySummary>(call(evaluationsRoute.GET, '/api/evaluations', { as: ada }))
    assert.equal(quality.feedback.negative, 1)
    assert.equal(quality.feedback.recent[0]?.question, 'When does it open?')
    const viewerQuality = await data<QualitySummary>(call(evaluationsRoute.GET, '/api/evaluations', { as: val }))
    assert.equal(viewerQuality.feedback.negative, 0, 'members only see their own feedback')
    assert.ok(questionId && conversationId)
    await repos.feedback.remove(answerId, ed.id)
  })

  // Reading the audit log (admins only) is the Go API's; this checks what these routes record.
  it('records content changes in the audit log', async () => {
    const events: AuditEvent[] = await repos.audit.list(team.workspaceId, 100)
    const actions = events.map((event) => event.action)
    assert.ok(actions.includes('source.added'))
    assert.equal(events.find((event) => event.action === 'source.added')?.actorEmail, 'ed@example.com')
  })
})
