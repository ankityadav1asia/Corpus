import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as documentFileRoute from '@/app/api/corpus/documents/[id]/file/route'
import * as documentRoute from '@/app/api/corpus/documents/[id]/route'
import * as uploadRoute from '@/app/api/learn/upload/route'
import * as publicShareRoute from '@/app/api/public/shares/[token]/route'
import * as shareRoute from '@/app/api/shares/[id]/route'
import * as sharesRoute from '@/app/api/shares/route'
import * as workspaceSharesRoute from '@/app/api/workspaces/[id]/shares/route'
import type { DocumentDetail, ShareLink, SharedView, UploadResult } from '@/lib/contracts'
import { SESSION_COOKIE } from '@/server/auth/session'
import { resetEnvCache } from '@/server/env'
import { setJobAutorun } from '@/server/jobs/trigger'
import { registryOf } from '@/server/connectors/registry'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { setServicesForTests, type Services } from '@/server/services'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, type FakeAi } from './helpers/fake-ai'
import { addDocument, createTeam, createUser, type TestUser } from './helpers/fixtures'
import { sessionToken } from './helpers/session'
import { makePdf } from './helpers/pdf'

const SECRET = 'q'.repeat(48)
const ORIGIN = 'http://localhost:3000'

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
  t = await createTestDb()
  repos = createRepositories(t.db)
  ai = createFakeAi()
  const services: Services = {
    db: t.db,
    repos,
    ai: () => ai,
    reranker: () => createLlmReranker(ai),
    vision: () => null,
    transcriber: () => null,
    ocr: () => null,
    connectors: () => registryOf({}),
    email: () => null,
    fetch: () => async () => new Response('offline', { status: 503 }),
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

/* ── Tests ────────────────────────────────────────────────────────────────── */

// Asking, with its fast helper calls and follow-up suggestions, is the Go API's (backend/api/chat_test.go).

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
