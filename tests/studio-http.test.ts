import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import * as connectionRoute from '@/app/api/connectors/connections/[id]/route'
import * as browseRoute from '@/app/api/connectors/connections/[id]/browse/route'
import * as connectorsRoute from '@/app/api/connectors/route'
import * as sourceItemRoute from '@/app/api/connectors/sources/[id]/route'
import * as sourceSyncRoute from '@/app/api/connectors/sources/[id]/sync/route'
import * as sourcesRoute from '@/app/api/connectors/sources/route'
import * as uploadRoute from '@/app/api/learn/upload/route'
import * as modelsRoute from '@/app/api/workspaces/[id]/models/route'
import * as reembedRoute from '@/app/api/workspaces/[id]/reembed/route'
import type { ConnectorBrowseResult, ConnectorsOverview, ConnectorSourceSummary, ModelsStatus, UploadResult } from '@/lib/contracts'
import { SESSION_COOKIE } from '@/server/auth/session'
import { registryOf } from '@/server/connectors/registry'
import type { Connector } from '@/server/connectors/types'
import { resetEnvCache } from '@/server/env'
import { runJobs } from '@/server/jobs/runner'
import { setJobAutorun } from '@/server/jobs/trigger'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { sealSecret } from '@/server/security/secrets'
import { setServicesForTests, type Services } from '@/server/services'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, createFakeOcr, createFakeVision, type FakeAi } from './helpers/fake-ai'
import { addDocument, createTeam, createUser, type TestUser } from './helpers/fixtures'
import { sessionToken } from './helpers/session'

const SECRET = 'q'.repeat(48)
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

const fakeDrive: Connector = {
  id: 'google_drive',
  async browse(context, { query }) {
    return {
      items: [
        {
          id: 'file-1',
          name: `Result for ${query ?? 'all'} (${context.credentials.accessToken})`,
          kind: 'file',
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
    return [{ externalId: 'file-1', version: 'v1', title: 'Onboarding guide', url: 'https://drive.google.com/file/d/file-1' }]
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
      vision: () => createFakeVision(),
      ocr: () => createFakeOcr(),
      connectors: () => registryOf({ google_drive: fakeDrive }),
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
    vision: () => createFakeVision(),
    transcriber: () => null,
    ocr: () => createFakeOcr(),
    connectors: () => registryOf({ google_drive: fakeDrive }),
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

  it('stores a connected Google Drive account encrypted and never returns its tokens', async () => {
    const connection = await repos.connectors.saveConnection({
      workspaceId: team.workspaceId,
      userId: ed.id,
      provider: 'google_drive',
      accountLabel: 'ed.studio@gmail.com',
      credentials: await sealSecret(JSON.stringify({ accessToken: 'ya29.secret', refreshToken: 'refresh-secret', expiresAt: String(Date.now() + 3_600_000) }), SECRET),
    })
    connectionId = connection.id
    const res = await call(connectorsRoute.GET, '/api/connectors', { as: ed })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.ok(!text.includes('ya29.secret') && !text.includes('refresh-secret'))
    const overview = JSON.parse(text) as ConnectorsOverview
    assert.deepEqual(
      overview.connections.map((item) => [item.id, item.provider, item.accountLabel]),
      [[connectionId, 'google_drive', 'ed.studio@gmail.com']],
    )
    const [row] = await t.db.query<{ credentials: string }>(`SELECT credentials FROM app.connections WHERE id = $1`, [connectionId])
    assert.ok(row!.credentials.startsWith('v1.') && !row!.credentials.includes('ya29.secret'), 'stored encrypted')
  })

  it('lets only the owner browse through a connection', async () => {
    const result = await data<ConnectorBrowseResult>(call(browseRoute.GET, `/api/connectors/connections/${connectionId}/browse?q=guide`, { as: ed, params: { id: connectionId } }))
    assert.equal(result.items[0]?.name, 'Result for guide (ya29.secret)', 'decrypted for the connector, never for the client')
    assert.equal((await call(browseRoute.GET, `/api/connectors/connections/${connectionId}/browse`, { as: ada, params: { id: connectionId } })).status, 404)
  })

  it('adds a file to a notebook, syncs it and shows it in the overview', async () => {
    const body = { collectionId: team.notebookId, provider: 'google_drive', connectionId, items: [{ externalId: 'file-1', kind: 'file', name: 'Onboarding' }] }
    assert.equal((await call(sourcesRoute.POST, '/api/connectors/sources', { method: 'POST', as: val, body })).status, 403)
    assert.equal((await call(sourcesRoute.POST, '/api/connectors/sources', { method: 'POST', as: ada, body })).status, 404, "an admin cannot import through someone else's account")
    assert.equal(
      (await call(sourcesRoute.POST, '/api/connectors/sources', { method: 'POST', as: ed, body: { ...body, items: [{ externalId: 'x', kind: 'repository', name: 'x' }] } })).status,
      400,
    )
    for (const provider of ['notion', 'github', 'website']) {
      assert.equal((await call(sourcesRoute.POST, '/api/connectors/sources', { method: 'POST', as: ed, body: { ...body, provider } })).status, 400, `${provider} was removed`)
    }
    const res = await call(sourcesRoute.POST, '/api/connectors/sources', { method: 'POST', as: ed, body })
    assert.equal(res.status, 202)
    sourceId = (await data<{ sources: ConnectorSourceSummary[] }>(res)).sources[0]!.id
    await jobs()
    const overview = await data<ConnectorsOverview>(call(connectorsRoute.GET, '/api/connectors', { as: val }))
    const source = overview.sources.find((item) => item.id === sourceId)
    assert.equal(source?.status, 'idle')
    assert.equal(source?.itemCount, 1)
    assert.deepEqual(overview.connections, [], 'members only see their own connections')
    assert.deepEqual(
      overview.providers.map((provider) => [provider.id, provider.available]),
      [['google_drive', true]],
    )
    const adminView = await data<ConnectorsOverview>(call(connectorsRoute.GET, '/api/connectors', { as: ada }))
    assert.equal(adminView.connections.length, 1, 'admins see every connection so they can remove them')
    const hits = await repos.documents.keywordSearch({ workspaceId: team.workspaceId, collectionId: team.notebookId, query: 'laptop buddy', limit: 3 })
    assert.equal(hits[0]?.sourceType, 'google_drive')
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
    const left = await t.db.query(`SELECT id FROM app.documents WHERE source_type = 'google_drive' AND workspace_id = $1`, [team.workspaceId])
    assert.equal(left.length, 0)
  })

  it('lets the owner or an admin disconnect an account', async () => {
    assert.equal((await call(connectionRoute.DELETE, `/api/connectors/connections/${connectionId}`, { method: 'DELETE', as: val, params: { id: connectionId } })).status, 403)
    assert.equal((await call(connectionRoute.DELETE, `/api/connectors/connections/${connectionId}`, { method: 'DELETE', as: ada, params: { id: connectionId } })).status, 200)
  })
})
