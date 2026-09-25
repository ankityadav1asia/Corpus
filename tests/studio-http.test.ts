import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as audioFileRoute from '@/app/api/audio/[id]/file/route'
import * as audioItemRoute from '@/app/api/audio/[id]/route'
import * as audioRoute from '@/app/api/audio/route'
import * as connectionRoute from '@/app/api/connectors/connections/[id]/route'
import * as browseRoute from '@/app/api/connectors/connections/[id]/browse/route'
import * as connectionsRoute from '@/app/api/connectors/connections/route'
import * as connectorsRoute from '@/app/api/connectors/route'
import * as sourceItemRoute from '@/app/api/connectors/sources/[id]/route'
import * as sourceSyncRoute from '@/app/api/connectors/sources/[id]/sync/route'
import * as sourcesRoute from '@/app/api/connectors/sources/route'
import * as uploadRoute from '@/app/api/learn/upload/route'
import * as mindMapRoute from '@/app/api/mindmaps/[id]/route'
import * as mindMapsRoute from '@/app/api/mindmaps/route'
import * as modelsRoute from '@/app/api/workspaces/[id]/models/route'
import * as reembedRoute from '@/app/api/workspaces/[id]/reembed/route'
import type {
  AudioDetail,
  AudioSummary,
  ConnectionSummary,
  ConnectorBrowseResult,
  ConnectorsOverview,
  ConnectorSourceSummary,
  MindMapDetail,
  MindMapSummary,
  ModelsStatus,
  UploadResult,
} from '@/lib/contracts'
import { SESSION_COOKIE } from '@/server/auth/session'
import { registryOf } from '@/server/connectors/registry'
import type { Connector } from '@/server/connectors/types'
import { createWebsiteConnector } from '@/server/connectors/website'
import { resetEnvCache } from '@/server/env'
import { runJobs } from '@/server/jobs/runner'
import { setJobAutorun } from '@/server/jobs/trigger'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { setServicesForTests, type Services } from '@/server/services'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, createFakeOcr, createFakeSpeech, createFakeVision, type FakeAi } from './helpers/fake-ai'
import { addDocument, createTeam, createUser, type TestUser } from './helpers/fixtures'
import { sessionToken } from './helpers/session'

const SECRET = 'q'.repeat(48)
const ORIGIN = 'http://localhost:3000'
let t: TestDb
let repos: Repositories
let ai: FakeAi
let services: Services
let speechOn = true

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
  init: { method?: string; as?: Actor; workspace?: string | null; body?: unknown; form?: FormData; params?: Record<string, string>; headers?: Record<string, string> } = {},
) {
  const headers = new Headers({ host: 'localhost:3000', ...init.headers })
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

const fakeNotion: Connector = {
  id: 'notion',
  async browse(context, { query }) {
    return {
      items: [
        {
          id: 'page-1',
          name: `Result for ${query ?? 'all'} (${context.credentials.token})`,
          kind: 'page',
          container: false,
          importable: true,
          mimeType: null,
          modifiedAt: null,
          size: null,
          url: null,
        },
      ],
      nextCursor: null,
    }
  },
  async list() {
    return [{ externalId: 'page-1', version: 'v1', title: 'Onboarding guide', url: 'https://notion.so/page-1' }]
  },
  async fetchItem(_context, item) {
    return { type: 'text', title: item.title, text: 'New hires get a laptop on day one and a buddy for the first month.', url: item.url, version: item.version }
  },
}

const jobs = () =>
  runJobs(
    {
      repos,
      ai: () => ai,
      reranker: () => createLlmReranker(ai),
      images: () => null,
      vision: () => createFakeVision(),
      ocr: () => createFakeOcr(),
      speech: () => createFakeSpeech(),
      connectors: () => registryOf({ notion: fakeNotion }),
      secret: () => SECRET,
    },
    { maxJobs: 50 },
  )

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
    images: () => null,
    vision: () => createFakeVision(),
    transcriber: () => null,
    speech: () => (speechOn ? createFakeSpeech() : null),
    ocr: () => createFakeOcr(),
    connectors: () => registryOf({ notion: fakeNotion, website: createWebsiteConnector() }),
    email: () => null,
  }
  setServicesForTests(services)
  ada = await actor('ada.studio@example.com')
  val = await actor('val.studio@example.com')
  ed = await actor('ed.studio@example.com')
  out = await actor('out.studio@example.com')
  team = await createTeam(repos, ada, [
    [val, 'viewer'],
    [ed, 'editor'],
  ])
  await addDocument(repos, {
    workspaceId: team.workspaceId,
    collectionId: team.notebookId,
    createdBy: ada.id,
    title: 'Field notes',
    chunks: ['Bees pollinate almond orchards in February.'],
  })
})

after(async () => {
  setServicesForTests(null)
  setJobAutorun(true)
  await t.close()
})

describe('media uploads', () => {
  it('stores images for background reading and rejects files whose content does not match the name', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const form = new FormData()
    form.set('collectionId', team.notebookId)
    form.append('files', new File([png], 'whiteboard.png', { type: 'image/png' }))
    form.append('files', new File(['not really audio'], 'song.mp3', { type: 'audio/mpeg' }))
    const res = await call(uploadRoute.POST, '/api/learn/upload', { method: 'POST', as: ed, form })
    assert.equal(res.status, 202)
    const { results } = await data<UploadResult>(res)
    assert.equal(results[0]?.status, 'queued')
    assert.equal(results[0]?.document?.mediaKind, 'image')
    assert.equal(results[0]?.document?.progress, 'Waiting to read the image')
    assert.equal(results[1]?.status, 'error')
    assert.match(results[1]!.error!, /does not look like a valid MP3/)
    await jobs()
    const document = await repos.documents.get(team.workspaceId, results[0]!.document!.id)
    assert.equal(document?.status, 'ready')
  })
})

describe('studio: audio overviews and mind maps', () => {
  let audioId: string
  let mindMapId: string

  it('lets any member request an audio overview of notebooks they can read', async () => {
    const created = await call(audioRoute.POST, '/api/audio', {
      method: 'POST',
      as: val,
      body: { collectionIds: [team.notebookId], format: 'debate', length: 'short', language: 'Hindi' },
    })
    assert.equal(created.status, 202)
    const { overview } = await data<{ overview: AudioSummary }>(created)
    audioId = overview.id
    assert.equal(overview.status, 'queued')
    assert.match(overview.title, /^Audio overview · /)
    assert.equal((await call(audioRoute.POST, '/api/audio', { method: 'POST', as: val, body: { collectionIds: [], documentIds: [] } })).status, 400)
    assert.equal((await call(audioRoute.POST, '/api/audio', { method: 'POST', as: out, body: { collectionIds: [team.notebookId] } })).status, 404)
    const foreign = await call(audioRoute.POST, '/api/audio', { method: 'POST', as: out, workspace: out.workspaceId, body: { collectionIds: [team.notebookId] } })
    assert.equal(foreign.status, 404, "another workspace's notebook is not found")
    speechOn = false
    assert.equal((await call(audioRoute.POST, '/api/audio', { method: 'POST', as: val, body: { collectionIds: [team.notebookId] } })).status, 503)
    speechOn = true

    await jobs()
    const { overview: detail } = await data<{ overview: AudioDetail }>(call(audioItemRoute.GET, `/api/audio/${audioId}`, { as: ed, params: { id: audioId } }))
    assert.equal(detail.status, 'completed')
    assert.equal(detail.language, 'Hindi')
    assert.ok(detail.transcript.length > 0)
  })

  it('streams the recording with byte ranges so the player can seek', async () => {
    const full = await call(audioFileRoute.GET, `/api/audio/${audioId}/file`, { as: val, workspace: null, params: { id: audioId } })
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), 'audio/mpeg')
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    const size = (await full.arrayBuffer()).byteLength
    const part = await call(audioFileRoute.GET, `/api/audio/${audioId}/file`, { as: val, workspace: null, params: { id: audioId }, headers: { range: 'bytes=10-19' } })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), `bytes 10-19/${size}`)
    assert.equal((await part.arrayBuffer()).byteLength, 10)
    const bad = await call(audioFileRoute.GET, `/api/audio/${audioId}/file`, { as: val, workspace: null, params: { id: audioId }, headers: { range: `bytes=${size + 5}-` } })
    assert.equal(bad.status, 416)
    assert.equal((await call(audioFileRoute.GET, `/api/audio/${audioId}/file`, { as: out, workspace: null, params: { id: audioId } })).status, 404)
    const download = await call(audioFileRoute.GET, `/api/audio/${audioId}/file?download=1`, { as: val, workspace: null, params: { id: audioId } })
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename=".+\.mp3"$/)
  })

  it('builds mind maps and lets only the author or an admin delete them', async () => {
    const created = await call(mindMapsRoute.POST, '/api/mindmaps', { method: 'POST', as: ed, body: { collectionIds: [team.notebookId], focus: 'pollination' } })
    assert.equal(created.status, 202)
    mindMapId = (await data<{ mindMap: MindMapSummary }>(created)).mindMap.id
    await jobs()
    const { mindMap } = await data<{ mindMap: MindMapDetail }>(call(mindMapRoute.GET, `/api/mindmaps/${mindMapId}`, { as: val, params: { id: mindMapId } }))
    assert.equal(mindMap.status, 'completed')
    assert.ok(mindMap.root && mindMap.root.children.length > 0)
    const { mindMaps } = await data<{ mindMaps: MindMapSummary[] }>(call(mindMapsRoute.GET, '/api/mindmaps', { as: val }))
    assert.ok(mindMaps.some((item) => item.id === mindMapId))
    assert.equal((await call(mindMapRoute.DELETE, `/api/mindmaps/${mindMapId}`, { method: 'DELETE', as: val, params: { id: mindMapId } })).status, 403)
    assert.equal((await call(audioItemRoute.DELETE, `/api/audio/${audioId}`, { method: 'DELETE', as: ed, params: { id: audioId } })).status, 403)
    assert.equal((await call(mindMapRoute.DELETE, `/api/mindmaps/${mindMapId}`, { method: 'DELETE', as: ada, params: { id: mindMapId } })).status, 200)
    assert.equal((await call(audioItemRoute.DELETE, `/api/audio/${audioId}`, { method: 'DELETE', as: val, params: { id: audioId } })).status, 200)
  })
})

describe('models and re-embedding', () => {
  it('shows which models are in use and lets admins re-embed older passages', async () => {
    const status = await data<ModelsStatus>(call(modelsRoute.GET, `/api/workspaces/${team.workspaceId}/models`, { as: val, workspace: null, params: { id: team.workspaceId } }))
    assert.equal(status.embeddings.active, 'fake-embedding')
    assert.ok(status.embeddings.stale >= 1, 'fixture passages carry no model')
    assert.ok(!JSON.stringify(status).includes('http'), 'no URLs or keys in the summary')
    const reembed = (who: Actor) =>
      call(reembedRoute.POST, `/api/workspaces/${team.workspaceId}/reembed`, { method: 'POST', as: who, workspace: null, params: { id: team.workspaceId } })
    assert.equal((await reembed(ed)).status, 403)
    assert.equal((await reembed(out)).status, 404)
    assert.equal((await reembed(ada)).status, 202)
    await jobs()
    const after = await data<ModelsStatus>(call(modelsRoute.GET, `/api/workspaces/${team.workspaceId}/models`, { as: ada, workspace: null, params: { id: team.workspaceId } }))
    assert.equal(after.embeddings.stale, 0)
    assert.equal((await reembed(ada)).status, 409, 'nothing left to do')
  })
})

describe('connectors over HTTP', () => {
  let connectionId: string
  let sourceId: string

  it('connects a Notion workspace with a checked token and never returns the token', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), 'https://api.notion.com/v1/users/me')
      return Response.json({ bot: { workspace_name: 'Acme Wiki' } })
    }) as typeof fetch
    try {
      assert.equal((await call(connectionsRoute.POST, '/api/connectors/connections', { method: 'POST', as: val, body: { provider: 'notion', token: 'ntn_secret' } })).status, 403)
      const res = await call(connectionsRoute.POST, '/api/connectors/connections', { method: 'POST', as: ed, body: { provider: 'notion', token: 'ntn_secret' } })
      assert.equal(res.status, 201)
      const text = await res.text()
      assert.ok(!text.includes('ntn_secret'))
      const { connection } = JSON.parse(text) as { connection: ConnectionSummary }
      assert.equal(connection.accountLabel, 'Acme Wiki')
      connectionId = connection.id
    } finally {
      globalThis.fetch = realFetch
    }
    const [row] = await t.db.query<{ credentials: string }>(`SELECT credentials FROM app.connections WHERE id = $1`, [connectionId])
    assert.ok(row!.credentials.startsWith('v1.') && !row!.credentials.includes('ntn_secret'), 'stored encrypted')
  })

  it('lets only the owner browse through a connection', async () => {
    const result = await data<ConnectorBrowseResult>(call(browseRoute.GET, `/api/connectors/connections/${connectionId}/browse?q=guide`, { as: ed, params: { id: connectionId } }))
    assert.equal(result.items[0]?.name, 'Result for guide (ntn_secret)', 'decrypted for the connector, never for the client')
    assert.equal((await call(browseRoute.GET, `/api/connectors/connections/${connectionId}/browse`, { as: ada, params: { id: connectionId } })).status, 404)
  })

  it('adds a page to a notebook, syncs it and shows it in the overview', async () => {
    const body = { collectionId: team.notebookId, provider: 'notion', connectionId, items: [{ externalId: 'page-1', kind: 'page', name: 'Onboarding' }] }
    assert.equal((await call(sourcesRoute.POST, '/api/connectors/sources', { method: 'POST', as: val, body })).status, 403)
    assert.equal((await call(sourcesRoute.POST, '/api/connectors/sources', { method: 'POST', as: ada, body })).status, 404, "an admin cannot import through someone else's account")
    assert.equal(
      (await call(sourcesRoute.POST, '/api/connectors/sources', { method: 'POST', as: ed, body: { ...body, items: [{ externalId: 'x', kind: 'repository', name: 'x' }] } })).status,
      400,
    )
    const res = await call(sourcesRoute.POST, '/api/connectors/sources', { method: 'POST', as: ed, body })
    assert.equal(res.status, 202)
    sourceId = (await data<{ sources: ConnectorSourceSummary[] }>(res)).sources[0]!.id
    await jobs()
    const overview = await data<ConnectorsOverview>(call(connectorsRoute.GET, '/api/connectors', { as: val }))
    const source = overview.sources.find((item) => item.id === sourceId)
    assert.equal(source?.status, 'idle')
    assert.equal(source?.itemCount, 1)
    assert.deepEqual(overview.connections, [], 'members only see their own connections')
    assert.equal(overview.providers.find((provider) => provider.id === 'google_drive')?.available, false)
    const adminView = await data<ConnectorsOverview>(call(connectorsRoute.GET, '/api/connectors', { as: ada }))
    assert.equal(adminView.connections.length, 1, 'admins see every connection so they can remove them')
    const hits = await repos.documents.keywordSearch({ workspaceId: team.workspaceId, collectionId: team.notebookId, query: 'laptop buddy', limit: 3 })
    assert.equal(hits[0]?.sourceType, 'notion')
  })

  it('rejects websites on private addresses', async () => {
    const res = await call(sourcesRoute.POST, '/api/connectors/sources', {
      method: 'POST',
      as: ed,
      body: { collectionId: team.notebookId, provider: 'website', connectionId: null, items: [{ externalId: 'http://127.0.0.1:8080/admin', kind: 'site', name: 'Internal' }] },
    })
    assert.equal(res.status, 400)
  })

  it('syncs on demand, updates the schedule and removes the source (optionally with its documents)', async () => {
    assert.equal((await call(sourceSyncRoute.POST, `/api/connectors/sources/${sourceId}/sync`, { method: 'POST', as: val, params: { id: sourceId } })).status, 403)
    assert.equal((await call(sourceSyncRoute.POST, `/api/connectors/sources/${sourceId}/sync`, { method: 'POST', as: ed, params: { id: sourceId } })).status, 202)
    assert.equal((await call(sourceSyncRoute.POST, `/api/connectors/sources/${sourceId}/sync`, { method: 'POST', as: ed, params: { id: sourceId } })).status, 202)
    const queued = await t.db.query(`SELECT id FROM app.jobs WHERE type = 'sync_connector' AND status = 'queued'`)
    assert.equal(queued.length, 1, 'a sync already queued is not duplicated')
    const patched = await data<{ source: ConnectorSourceSummary }>(
      call(sourceItemRoute.PATCH, `/api/connectors/sources/${sourceId}`, { method: 'PATCH', as: ed, params: { id: sourceId }, body: { autoSync: false, syncIntervalHours: 6 } }),
    )
    assert.deepEqual([patched.source.autoSync, patched.source.syncIntervalHours], [false, 6])
    assert.equal((await call(sourceItemRoute.DELETE, `/api/connectors/sources/${sourceId}?documents=delete`, { method: 'DELETE', as: ed, params: { id: sourceId } })).status, 200)
    const left = await t.db.query(`SELECT id FROM app.documents WHERE source_type = 'notion' AND workspace_id = $1`, [team.workspaceId])
    assert.equal(left.length, 0)
  })

  it('lets the owner or an admin disconnect an account', async () => {
    assert.equal((await call(connectionRoute.DELETE, `/api/connectors/connections/${connectionId}`, { method: 'DELETE', as: val, params: { id: connectionId } })).status, 403)
    assert.equal((await call(connectionRoute.DELETE, `/api/connectors/connections/${connectionId}`, { method: 'DELETE', as: ada, params: { id: connectionId } })).status, 200)
  })
})
