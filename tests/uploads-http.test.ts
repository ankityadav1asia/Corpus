import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as wholeRoute from '@/app/api/learn/upload/route'
import * as uploadRoute from '@/app/api/learn/uploads/[id]/route'
import * as completeRoute from '@/app/api/learn/uploads/[id]/complete/route'
import * as partRoute from '@/app/api/learn/uploads/[id]/parts/[index]/route'
import * as startRoute from '@/app/api/learn/uploads/route'
import { setActiveWorkspaceId } from '@/lib/api-client'
import { LIMITS } from '@/lib/constants'
import type { UploadResult, UploadStarted } from '@/lib/contracts'
import { uploadFile } from '@/lib/upload-client'
import { SESSION_COOKIE } from '@/server/auth/session'
import { resetEnvCache } from '@/server/env'
import { setJobAutorun } from '@/server/jobs/trigger'
import { registryOf } from '@/server/connectors/registry'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { setServicesForTests, type Services } from '@/server/services'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi } from './helpers/fake-ai'
import { createTeam, createUser, type TestUser } from './helpers/fixtures'
import { sessionToken } from './helpers/session'

const SECRET = 'u'.repeat(48)
const ORIGIN = 'http://localhost:3000'
const PART = LIMITS.uploadPartBytes

let t: TestDb
let repos: Repositories

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
  init: { method?: string; as: Actor; workspace?: string; body?: unknown; bytes?: Uint8Array; params?: Record<string, string> },
): Promise<Response> {
  const method = init.method ?? 'GET'
  const headers = new Headers({ host: 'localhost:3000', cookie: `${SESSION_COOKIE}=${init.as.cookie}`, 'x-workspace-id': init.workspace ?? team.workspaceId })
  if (method !== 'GET') headers.set('origin', ORIGIN)
  let body: BodyInit | undefined
  if (init.bytes) {
    body = init.bytes as BodyInit
    headers.set('content-type', 'application/octet-stream')
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body)
    headers.set('content-type', 'application/json')
  }
  return (handler as Handler)(new NextRequest(`${ORIGIN}${path}`, { method, headers, body }), { params: Promise.resolve(init.params ?? {}) })
}

async function data<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

async function errorCode(res: Response | Promise<Response>): Promise<[number, string]> {
  const response = await res
  const body = (await response.json()) as { error?: { code?: string } }
  return [response.status, body.error?.code ?? '']
}

function start(as: Actor, fileName: string, byteSize: number, collectionId = team.notebookId) {
  return call(startRoute.POST, '/api/learn/uploads', { method: 'POST', as, body: { collectionId, fileName, byteSize } })
}

function putPart(as: Actor, uploadId: string, index: number | string, bytes: Uint8Array, workspace?: string) {
  return call(partRoute.PUT, `/api/learn/uploads/${uploadId}/parts/${index}`, { method: 'PUT', as, bytes, workspace, params: { id: uploadId, index: String(index) } })
}

function complete(as: Actor, uploadId: string) {
  return call(completeRoute.POST, `/api/learn/uploads/${uploadId}/complete`, { method: 'POST', as, params: { id: uploadId } })
}

function abort(as: Actor, uploadId: string) {
  return call(uploadRoute.DELETE, `/api/learn/uploads/${uploadId}`, { method: 'DELETE', as, params: { id: uploadId } })
}

/** Starts an upload and sends every part in order. */
async function sendAll(as: Actor, fileName: string, bytes: Uint8Array): Promise<string> {
  const { uploadId, parts } = await data<UploadStarted>(start(as, fileName, bytes.byteLength))
  for (let index = 0; index < parts; index++) {
    assert.equal((await putPart(as, uploadId, index, bytes.subarray(index * PART, (index + 1) * PART))).status, 200)
  }
  return uploadId
}

/** An MP3 by its magic bytes (ID3), with random content. */
function mp3(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(randomBytes(size))
  bytes.set([0x49, 0x44, 0x33])
  return bytes
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
  const ai = createFakeAi()
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
  ada = await actor('ada@example.com')
  ed = await actor('ed@example.com')
  val = await actor('val@example.com')
  team = await createTeam(repos, ada, [
    [ed, 'editor'],
    [val, 'viewer'],
  ])
})

after(async () => {
  delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest
  setActiveWorkspaceId(null)
  setServicesForTests(null)
  setJobAutorun(true)
  await t.close()
})

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe('uploads in parts', () => {
  it('reassembles parts sent in any order, with retries, into the same document as a one-request upload', async () => {
    const file = mp3(4 * PART + 12_345)
    const started = await start(ed, 'lecture.mp3', file.byteLength)
    assert.equal(started.status, 201)
    const { uploadId, partBytes, parts } = await data<UploadStarted>(started)
    assert.deepEqual([partBytes, parts], [PART, 5])

    const part = (index: number) => file.subarray(index * PART, (index + 1) * PART)
    for (const index of [4, 1, 0, 3]) assert.equal((await putPart(ed, uploadId, index, part(index))).status, 200)
    assert.equal((await putPart(ed, uploadId, 1, part(1))).status, 200, 'sending a part again is safe')
    assert.deepEqual(await errorCode(complete(ed, uploadId)), [409, 'CONFLICT'], 'part 2 is missing')

    assert.equal((await putPart(ed, uploadId, 2, part(2))).status, 200)
    const done = await complete(ed, uploadId)
    assert.equal(done.status, 202)
    const [result] = (await data<UploadResult>(done)).results
    assert.equal(result?.status, 'queued')
    assert.equal(result?.document?.status, 'processing')
    assert.equal(result?.document?.byteSize, file.byteLength)
    const stored = await repos.media.bytes(result!.document!.id)
    assert.ok(Buffer.from(stored).equals(Buffer.from(file)), 'the stored media is byte-for-byte the uploaded file')

    const [left] = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.upload_session_parts WHERE upload_id = $1', [uploadId])
    assert.equal(left?.n, 0, 'the parts are removed')
    assert.deepEqual(await errorCode(complete(ed, uploadId)), [404, 'NOT_FOUND'], 'an upload completes once')
  })

  it('checks the file and the caller before any byte is sent', async () => {
    assert.deepEqual(await errorCode(start(ed, 'program.exe', 10)), [415, 'UNSUPPORTED_MEDIA_TYPE'])
    assert.deepEqual(await errorCode(start(ed, 'huge.mp4', LIMITS.fileBytes + 1)), [413, 'PAYLOAD_TOO_LARGE'])
    assert.deepEqual(await errorCode(start(ed, 'empty.txt', 0)), [422, 'UNPROCESSABLE'])
    assert.deepEqual(await errorCode(start(val, 'notes.txt', 10)), [403, 'FORBIDDEN'], 'viewers cannot add sources')
    assert.deepEqual(await errorCode(start(ed, 'notes.txt', 10, ed.notebookId)), [404, 'NOT_FOUND'], 'a notebook of another workspace')
    assert.deepEqual(await errorCode(call(startRoute.POST, '/api/learn/uploads', { method: 'POST', as: ed, body: { collectionId: team.notebookId } })), [400, 'VALIDATION_FAILED'])
  })

  it("accepts only exact parts, and only of the uploader's own unexpired upload", async () => {
    const { uploadId } = await data<UploadStarted>(start(ed, 'talk.mp3', PART + 100))
    assert.deepEqual(await errorCode(putPart(ed, uploadId, 2, new Uint8Array(100))), [400, 'BAD_REQUEST'], 'no such part')
    assert.deepEqual(await errorCode(putPart(ed, uploadId, 'first', new Uint8Array(100))), [400, 'VALIDATION_FAILED'])
    assert.deepEqual(await errorCode(putPart(ed, uploadId, 1, new Uint8Array(99))), [400, 'BAD_REQUEST'], 'the last part holds exactly the rest')
    assert.deepEqual(await errorCode(putPart(ed, uploadId, 0, new Uint8Array(PART + 1))), [413, 'PAYLOAD_TOO_LARGE'])
    assert.equal((await putPart(ed, uploadId, 1, new Uint8Array(100))).status, 200)

    assert.deepEqual(await errorCode(putPart(ada, uploadId, 0, new Uint8Array(PART))), [404, 'NOT_FOUND'], 'not even an admin can add to it')
    assert.deepEqual(await errorCode(putPart(val, uploadId, 0, new Uint8Array(PART))), [404, 'NOT_FOUND'])
    assert.deepEqual(await errorCode(complete(ada, uploadId)), [404, 'NOT_FOUND'])
    assert.deepEqual(await errorCode(abort(ada, uploadId)), [404, 'NOT_FOUND'])
    assert.deepEqual(await errorCode(putPart(ed, uploadId, 0, new Uint8Array(PART), ed.workspaceId)), [404, 'NOT_FOUND'], 'named under another workspace')

    await t.db.query(`UPDATE app.upload_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [uploadId])
    assert.deepEqual(await errorCode(putPart(ed, uploadId, 0, new Uint8Array(PART))), [404, 'NOT_FOUND'], 'expired')
    assert.ok((await repos.uploads.purgeExpired()) >= 1)
    const [row] = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.upload_sessions WHERE id = $1', [uploadId])
    assert.equal(row?.n, 0, 'expired uploads are purged with their parts')
  })

  it('reports a file that cannot be read like a one-request upload does', async () => {
    const notPng = new Uint8Array(PART + 10).fill(0x41)
    const uploadId = await sendAll(ed, 'photo.png', notPng)
    const res = await complete(ed, uploadId)
    assert.equal(res.status, 422)
    const [result] = (await data<UploadResult>(res)).results
    assert.equal(result?.status, 'error')
    assert.match(result?.error ?? '', /does not look like a valid PNG/)
  })

  it('limits uploads in progress and lets the uploader cancel one', async () => {
    const open: string[] = []
    for (let i = 0; i < LIMITS.openUploads; i++) open.push((await data<UploadStarted>(start(ed, `clip-${i}.mp3`, 1_000))).uploadId)
    assert.deepEqual(await errorCode(start(ed, 'one-more.mp3', 1_000)), [409, 'CONFLICT'])
    assert.equal((await start(ada, 'admin.mp3', 1_000)).status, 201, 'the limit is per person')

    const res = await abort(ed, open[0]!)
    assert.equal(res.status, 200)
    assert.deepEqual(await errorCode(putPart(ed, open[0]!, 0, new Uint8Array(1_000))), [404, 'NOT_FOUND'])
    assert.deepEqual(await errorCode(abort(ed, open[0]!)), [404, 'NOT_FOUND'])
    assert.equal((await start(ed, 'one-more.mp3', 1_000)).status, 201, 'cancelling frees a slot')
    await t.db.query('DELETE FROM app.upload_sessions')
  })
})

/* ── The browser client against the real routes ───────────────────────────── */

const ROUTES: Array<{ method: string; path: RegExp; handler: unknown; params: (match: RegExpExecArray) => Record<string, string> }> = [
  { method: 'POST', path: /^\/api\/learn\/upload$/, handler: wholeRoute.POST, params: () => ({}) },
  { method: 'POST', path: /^\/api\/learn\/uploads$/, handler: startRoute.POST, params: () => ({}) },
  { method: 'PUT', path: /^\/api\/learn\/uploads\/([^/]+)\/parts\/(\d+)$/, handler: partRoute.PUT, params: (m) => ({ id: m[1]!, index: m[2]! }) },
  { method: 'POST', path: /^\/api\/learn\/uploads\/([^/]+)\/complete$/, handler: completeRoute.POST, params: (m) => ({ id: m[1]! }) },
  { method: 'DELETE', path: /^\/api\/learn\/uploads\/([^/]+)$/, handler: uploadRoute.DELETE, params: (m) => ({ id: m[1]! }) },
]

/** XMLHttpRequest as a browser sends it (session cookie, same origin), answered by the route handlers. */
class RoutedXhr {
  static as: Actor
  static sent: string[] = []
  static inFlight: Array<Promise<void>> = []
  /** Requests for which this returns true fail like a dropped connection. */
  static drop: (method: string, url: string) => boolean = () => false

  status = 0
  responseText = ''
  withCredentials = false
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private method = 'GET'
  private url = ''
  private readonly headers = new Headers({ host: 'localhost:3000', origin: ORIGIN })

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value)
  }

  send(body: Blob | FormData | string | null) {
    RoutedXhr.inFlight.push(this.answer(body))
  }

  private async answer(body: Blob | FormData | string | null) {
    await Promise.resolve()
    RoutedXhr.sent.push(`${this.method} ${this.url}`)
    if (RoutedXhr.drop(this.method, this.url)) return this.onerror?.()
    if (body instanceof Blob) this.upload.onprogress?.({ lengthComputable: true, loaded: body.size, total: body.size })
    const route = ROUTES.find((candidate) => candidate.method === this.method && candidate.path.test(this.url))!
    this.headers.set('cookie', `${SESSION_COOKIE}=${RoutedXhr.as.cookie}`)
    const req = new NextRequest(`${ORIGIN}${this.url}`, { method: this.method, headers: this.headers, body: body ?? undefined })
    const res = await (route.handler as Handler)(req, { params: Promise.resolve(route.params(route.path.exec(this.url)!)) })
    this.status = res.status
    this.responseText = await res.text()
    this.onload?.()
  }
}

describe('the browser upload client', () => {
  before(() => {
    ;(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = RoutedXhr
    setActiveWorkspaceId(team.workspaceId)
    RoutedXhr.as = ed
  })

  it('sends small files whole, and large ones in parts, retrying a part whose connection dropped', async () => {
    RoutedXhr.sent = []
    const small = await uploadFile(new File(['Tides follow the moon, twice a day.'], 'tides.txt'), team.notebookId, () => undefined)
    assert.equal(small.status, 'queued')
    assert.deepEqual(RoutedXhr.sent, ['POST /api/learn/upload'])

    RoutedXhr.sent = []
    let dropped = 0
    RoutedXhr.drop = (method, url) => method === 'PUT' && url.endsWith('/parts/1') && dropped++ === 0
    const bytes = mp3(2 * PART + 500)
    const progress: number[] = []
    const large = await uploadFile(new File([bytes], 'podcast.mp3'), team.notebookId, (fraction) => progress.push(fraction), { retryDelayMs: 1 })
    RoutedXhr.drop = () => false

    assert.equal(large.status, 'queued', large.error)
    const id = (path: string) => path.replace(/^.*\/api\/learn\/uploads\/([^/]+).*$/, '$1')
    const uploadId = id(RoutedXhr.sent[1]!)
    assert.deepEqual(RoutedXhr.sent, [
      'POST /api/learn/uploads',
      `PUT /api/learn/uploads/${uploadId}/parts/0`,
      `PUT /api/learn/uploads/${uploadId}/parts/1`,
      `PUT /api/learn/uploads/${uploadId}/parts/1`,
      `PUT /api/learn/uploads/${uploadId}/parts/2`,
      `POST /api/learn/uploads/${uploadId}/complete`,
    ])
    assert.ok(
      progress.every((value, i) => i === 0 || value >= progress[i - 1]!),
      'progress only moves forward',
    )
    assert.equal(progress.at(-1), 1)
    assert.ok(Buffer.from(await repos.media.bytes(large.document!.id)).equals(Buffer.from(bytes)))
  })

  it('gives up on a part that keeps failing and discards the parts already sent', async () => {
    RoutedXhr.sent = []
    RoutedXhr.drop = (method, url) => method === 'PUT' && url.endsWith('/parts/1')
    const result = await uploadFile(new File([mp3(PART + 10)], 'broken-link.mp3'), team.notebookId, () => undefined, { retryDelayMs: 1 })
    RoutedXhr.drop = () => false
    await Promise.all(RoutedXhr.inFlight)

    assert.equal(result.status, 'error')
    assert.match(result.error ?? '', /interrupted/)
    assert.equal(RoutedXhr.sent.filter((request) => request.endsWith('/parts/1')).length, 3, 'three tries')
    assert.match(RoutedXhr.sent.at(-1)!, /^DELETE \/api\/learn\/uploads\//)
    assert.equal(await repos.uploads.openCount(team.workspaceId, ed.id), 0, 'nothing is left behind')
  })

  it("shows the server's reason when an upload is refused", async () => {
    const result = await uploadFile(new File([new Uint8Array(PART + 1)], 'setup.exe'), team.notebookId, () => undefined)
    assert.equal(result.status, 'error')
    assert.match(result.error ?? '', /not a supported file type/)
  })
})
