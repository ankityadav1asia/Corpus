import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import { signToken } from '@/server/auth/session'
import { createGoogleDriveConnector } from '@/server/connectors/google-drive'
import { completeDriveAuthorization } from '@/server/connectors/google-oauth'
import { registryOf } from '@/server/connectors/registry'
import { queueDueSyncs, syncConnectorSource } from '@/server/connectors/sync'
import { ConnectorError, type Connector, type ConnectorContext, type FetchedItem, type SyncItem } from '@/server/connectors/types'
import { resetEnvCache } from '@/server/env'
import { PermanentJobError } from '@/server/jobs/errors'
import { runJobs } from '@/server/jobs/runner'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { SecretUnreadableError, openSecret, sealSecret } from '@/server/security/secrets'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi } from './helpers/fake-ai'
import { createTeam, createUser, type TestUser } from './helpers/fixtures'

const SECRET = 's'.repeat(48)

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init })
    return respond(String(url), init)
  }) as typeof fetch
  return { requests, fetchImpl }
}

function contextWith(fetchImpl: typeof fetch, credentials: Record<string, string> = {}) {
  const saved: Array<Record<string, string>> = []
  const context: ConnectorContext = { credentials, fetch: fetchImpl, saveCredentials: async (next) => void saved.push(next) }
  return { context, saved }
}

describe('credential encryption', () => {
  it('seals credentials with a random IV and refuses tampered data or another secret', async () => {
    const one = await sealSecret('{"token":"ntn_secret"}', SECRET)
    const two = await sealSecret('{"token":"ntn_secret"}', SECRET)
    assert.notEqual(one, two)
    assert.ok(!one.includes('ntn_secret'))
    assert.equal(await openSecret(one, SECRET), '{"token":"ntn_secret"}')
    const tampered = one.slice(0, -2) + (one.endsWith('A') ? 'BB' : 'AA')
    await assert.rejects(openSecret(tampered, SECRET), SecretUnreadableError)
    await assert.rejects(openSecret(one, 'x'.repeat(48)), SecretUnreadableError)
    await assert.rejects(openSecret('garbage', SECRET), SecretUnreadableError)
  })
})

describe('Google Drive', () => {
  const client = { clientId: 'client', clientSecret: 'secret' }

  it('refreshes an expired access token and saves it', async () => {
    const { requests, fetchImpl } = mockFetch((url) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fresh', expires_in: 3600 })
      return Response.json({ files: [{ id: 'f1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: 'm1' }] })
    })
    const drive = createGoogleDriveConnector(client)
    const { context, saved } = contextWith(fetchImpl, { accessToken: 'old', expiresAt: String(Date.now() - 1000), refreshToken: 'refresh' })
    const page = await drive.browse(context, { parentId: null, query: null, cursor: null })
    assert.equal(saved[0]?.accessToken, 'fresh')
    assert.equal((requests[1]!.init.headers as Record<string, string>).Authorization, 'Bearer fresh')
    assert.deepEqual(
      page.items.map((item) => [item.name, item.container, item.importable]),
      [
        ['Shared with me', true, false],
        ['Plan', false, true],
      ],
    )
    assert.equal(new URL(requests[1]!.url).searchParams.get('q'), "'root' in parents and trashed = false")
  })

  it('exports Google Docs as Markdown (falling back to text) and downloads other files for the upload pipeline', async () => {
    const { requests, fetchImpl } = mockFetch((url) => {
      if (url.includes('mimeType=text%2Fmarkdown')) return new Response('nope', { status: 400 })
      if (url.includes('mimeType=text%2Fplain')) return new Response('Plan text')
      if (url.includes('alt=media')) return new Response(new Uint8Array([37, 80, 68, 70]))
      return new Response('{}', { status: 404 })
    })
    const drive = createGoogleDriveConnector(client)
    const { context } = contextWith(fetchImpl, { accessToken: 'ok', expiresAt: String(Date.now() + 3_600_000), refreshToken: 'r' })
    const source = { externalId: 'folder', kind: 'folder' as const, name: 'Folder', options: {} }
    const doc = await drive.fetchItem(context, { externalId: 'd1', version: 'v', title: 'Plan', url: null, meta: { mimeType: 'application/vnd.google-apps.document' } }, source)
    assert.deepEqual(doc, { type: 'text', title: 'Plan', text: 'Plan text', url: null, version: 'v' })
    const pdf = await drive.fetchItem(context, { externalId: 'p1', version: 'v', title: 'Scan', url: null, meta: { mimeType: 'application/pdf', size: '4' } }, source)
    assert.equal(pdf.type, 'file')
    assert.equal(pdf.type === 'file' && pdf.fileName, 'Scan.pdf', 'an extension is added from the file type')
    await assert.rejects(
      drive.fetchItem(context, { externalId: 'z', version: 'v', title: 'big.zip', url: null, meta: { mimeType: 'application/zip', size: '10' } }, source),
      /not a supported file type/,
    )
    assert.ok(requests.every((request) => (request.init.headers as Record<string, string>).Authorization === 'Bearer ok'))
  })

  it('only completes a connection started by the same member, and requires offline access', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client'
    process.env.GOOGLE_CLIENT_SECRET = 'secret'
    process.env.APP_URL = 'https://corpus.example'
    resetEnvCache()
    try {
      const cookie = await signToken({ s: 'state-1', v: 'verifier', w: '00000000-0000-4000-8000-000000000001', u: 'user-1', exp: Math.floor(Date.now() / 1000) + 600 }, SECRET)
      const base = { code: 'code', state: 'state-1', cookieValue: cookie, requestUrl: 'https://corpus.example/api/connectors/google-drive/callback', secret: SECRET }
      const ok = mockFetch((url) =>
        url.includes('token')
          ? Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.readonly' })
          : Response.json({ email: 'me@example.com' }),
      )
      await assert.rejects(completeDriveAuthorization({ ...base, userId: 'someone-else', fetch: ok.fetchImpl }), ConnectorError)
      await assert.rejects(completeDriveAuthorization({ ...base, state: 'forged', userId: 'user-1', fetch: ok.fetchImpl }), ConnectorError)
      const grant = await completeDriveAuthorization({ ...base, userId: 'user-1', fetch: ok.fetchImpl })
      assert.equal(grant.email, 'me@example.com')
      assert.equal(grant.credentials.refreshToken, 'r')
      const body = new URLSearchParams(String(ok.requests[0]!.init.body))
      assert.equal(body.get('code_verifier'), 'verifier')
      assert.equal(body.get('redirect_uri'), 'https://corpus.example/api/connectors/google-drive/callback')
      const noRefresh = mockFetch(() => Response.json({ access_token: 'a', scope: 'drive.readonly' }))
      await assert.rejects(completeDriveAuthorization({ ...base, userId: 'user-1', fetch: noRefresh.fetchImpl }), /offline access/)
    } finally {
      delete process.env.GOOGLE_CLIENT_ID
      delete process.env.GOOGLE_CLIENT_SECRET
      delete process.env.APP_URL
      resetEnvCache()
    }
  })
})

describe('sync engine', () => {
  let t: TestDb
  let repos: Repositories
  let owner: TestUser

  before(async () => {
    t = await createTestDb()
    repos = createRepositories(t.db)
    owner = await createUser(repos, 'sync@example.com')
  })
  after(() => t.close())
  afterEach(async () => {
    await t.db.query('DELETE FROM app.jobs')
  })

  /** A connector over an in-memory "app" whose items the test can change between syncs. */
  function fakeApp(initial: Record<string, { version: string; text?: string; file?: { name: string; data: Uint8Array }; fail?: 'bad' | 'auth' | 'outage' }>) {
    const items = { ...initial }
    const fetched: string[] = []
    const connector: Connector = {
      id: 'google_drive',
      async browse() {
        return { items: [], nextCursor: null }
      },
      async list() {
        return Object.entries(items).map(([id, item]): SyncItem => ({ externalId: id, version: item.version, title: `Page ${id}`, url: `https://drive.google.com/file/d/${id}` }))
      },
      async fetchItem(_context, item): Promise<FetchedItem> {
        fetched.push(item.externalId)
        const entry = items[item.externalId]!
        if (entry.fail === 'bad') throw new ConnectorError('This file type is not supported.')
        if (entry.fail === 'auth') throw new ConnectorError('Google Drive refused access (401).', 401, false, true)
        if (entry.fail === 'outage') throw new ConnectorError('Google Drive request failed (503)', 503, true)
        if (entry.file) return { type: 'file', title: item.title, fileName: entry.file.name, data: entry.file.data, url: item.url, version: item.version }
        return { type: 'text', title: item.title, text: entry.text ?? `Content of ${item.externalId} version ${entry.version}.`, url: item.url, version: item.version }
      },
    }
    return { items, fetched, connector }
  }

  async function newSource(name: string) {
    const connection = await repos.connectors.saveConnection({
      workspaceId: owner.workspaceId,
      userId: owner.id,
      provider: 'google_drive',
      accountLabel: `drive-${name}@example.com`,
      credentials: await sealSecret(JSON.stringify({ refreshToken: 'refresh' }), SECRET),
    })
    const source = await repos.connectors.saveSource({
      workspaceId: owner.workspaceId,
      collectionId: owner.notebookId,
      connectionId: connection.id,
      createdBy: owner.id,
      provider: 'google_drive',
      kind: 'folder',
      externalId: `folder-${name}`,
      name,
      url: null,
      options: {},
      autoSync: true,
      syncIntervalHours: 24,
    })
    return { source, connection }
  }

  const deps = (connector: Connector) => ({ repos, connectors: registryOf({ google_drive: connector }), secret: SECRET })
  const index = () => runJobs({ repos, ai: () => createFakeAi(), reranker: () => createLlmReranker(createFakeAi()) }, { maxJobs: 50, types: ['ingest_document', 'read_media'] })
  const documentsOf = async (sourceId: string) =>
    t.db.query<{ external_id: string; external_version: string; status: string; source_type: string }>(
      `SELECT external_id, external_version, status, source_type FROM app.documents WHERE connector_source_id = $1 ORDER BY external_id, created_at`,
      [sourceId],
    )

  it('imports new items, skips unchanged ones, replaces changed ones and removes deleted ones', async () => {
    const app = fakeApp({
      a: { version: '1' },
      b: { version: '1' },
      c: { version: '1', file: { name: 'notes.txt', data: new TextEncoder().encode('Plain text file from the app.') } },
    })
    const { source } = await newSource('Handbook')
    assert.equal(await syncConnectorSource(deps(app.connector), source.id, Date.now() + 60_000), 'done')
    await index()
    let documents = await documentsOf(source.id)
    assert.deepEqual(
      documents.map((document) => [document.external_id, document.status, document.source_type]),
      [
        ['a', 'ready', 'google_drive'],
        ['b', 'ready', 'google_drive'],
        ['c', 'ready', 'google_drive'],
      ],
    )
    const summary = await repos.connectors.getSource(owner.workspaceId, source.id)
    assert.equal(summary?.status, 'idle')
    assert.equal(summary?.itemCount, 3)
    assert.ok(summary?.nextSyncAt && new Date(summary.nextSyncAt).getTime() > Date.now() + 23 * 3600_000)
    const kinds = (await repos.notifications.list(owner.id)).items.map((item) => item.kind)
    assert.ok(kinds.includes('sync_done'))
    assert.ok(!kinds.includes('document_ready'), 'one notification per sync, not one per imported file')

    // Second sync: nothing changed upstream, nothing is fetched or re-indexed.
    app.fetched.length = 0
    await syncConnectorSource(deps(app.connector), source.id, Date.now() + 60_000)
    assert.deepEqual(app.fetched, [])

    // b changes, c disappears.
    app.items.b = { version: '2', text: 'Rewritten page b with the new pricing.' }
    delete app.items.c
    await syncConnectorSource(deps(app.connector), source.id, Date.now() + 60_000)
    assert.deepEqual(app.fetched, ['b'])
    await index()
    documents = await documentsOf(source.id)
    assert.deepEqual(
      documents.map((document) => [document.external_id, document.external_version]),
      [
        ['a', '1'],
        ['b', '2'],
      ],
      'the old version of b is replaced once the new one is ready, and c is gone',
    )
  })

  it('skips unreadable items with a reason and resumes an interrupted sync where it stopped', async () => {
    const app = fakeApp({ a: { version: '1' }, bad: { version: '1', fail: 'bad' }, c: { version: '1' }, d: { version: '1' } })
    const { source } = await newSource('Resumable')
    let lists = 0
    let fetches = 0
    const list = app.connector.list.bind(app.connector)
    const fetchItem = app.connector.fetchItem.bind(app.connector)
    app.connector.list = async (...args) => {
      lists++
      return list(...args)
    }
    app.connector.fetchItem = async (...args) => {
      fetches++
      return fetchItem(...args)
    }
    // The time budget is already used up: the listing is saved and nothing is fetched yet.
    assert.equal(await syncConnectorSource(deps(app.connector), source.id, Date.now() - 1), 'more')
    const saved = await repos.connectors.sourceForSync(source.id)
    assert.deepEqual([saved?.syncState?.index, saved?.syncState?.items.length, fetches], [0, 4, 0])
    assert.equal(await syncConnectorSource(deps(app.connector), source.id, Date.now() + 60_000), 'done')
    assert.deepEqual([lists, fetches], [1, 4], 'the second run continues the saved listing instead of listing again')
    const summary = await repos.connectors.getSource(owner.workspaceId, source.id)
    assert.equal(summary?.status, 'idle')
    assert.match(summary?.lastError ?? '', /1 item could not be imported: Page bad: This file type is not supported/)
  })

  it('stops on revoked access: the connection and source show the error and the member is told', async () => {
    const app = fakeApp({ a: { version: '1', fail: 'auth' } })
    const { source, connection } = await newSource('Revoked')
    await assert.rejects(syncConnectorSource(deps(app.connector), source.id, Date.now() + 60_000), PermanentJobError)
    assert.equal((await repos.connectors.getSource(owner.workspaceId, source.id))?.status, 'error')
    const connections = await repos.connectors.listConnections(owner.workspaceId, owner.id, false)
    assert.equal(connections.find((item) => item.id === connection.id)?.status, 'error')
    assert.equal((await repos.notifications.list(owner.id)).items[0]?.kind, 'sync_failed')
  })

  it("syncs only with its adder's current rights; removing the member removes their connections and links", async () => {
    const lead = await createUser(repos, 'lead@example.com')
    const ed = await createUser(repos, 'ed-sync@example.com')
    const team = await createTeam(repos, lead, [[ed, 'editor']])
    const connection = await repos.connectors.saveConnection({
      workspaceId: team.workspaceId,
      userId: ed.id,
      provider: 'google_drive',
      accountLabel: 'ed@example.com',
      credentials: await sealSecret(JSON.stringify({ refreshToken: 'refresh' }), SECRET),
    })
    const source = await repos.connectors.saveSource({
      workspaceId: team.workspaceId,
      collectionId: team.notebookId,
      connectionId: connection.id,
      createdBy: ed.id,
      provider: 'google_drive',
      kind: 'folder',
      externalId: 'folder-team',
      name: 'Team wiki',
      url: null,
      options: {},
      autoSync: true,
      syncIntervalHours: 24,
    })
    const app = fakeApp({ a: { version: '1' } })
    assert.equal(await syncConnectorSource(deps(app.connector), source.id, Date.now() + 60_000), 'done')

    // Demoted to viewer: the next scheduled sync stops instead of using Ed's Google Drive access.
    await repos.workspaces.setRole(team.workspaceId, ed.id, 'viewer')
    await assert.rejects(syncConnectorSource(deps(app.connector), source.id, Date.now() + 60_000), PermanentJobError)
    const stopped = await repos.connectors.getSource(team.workspaceId, source.id)
    assert.equal(stopped?.status, 'error')
    assert.match(stopped?.lastError ?? '', /can no longer add sources/)

    // Removed from the workspace: their connection, its sources and their public links go.
    await repos.workspaces.setRole(team.workspaceId, ed.id, 'editor')
    const conversation = await repos.conversations.create({ workspaceId: team.workspaceId, ownerId: ed.id, collectionId: null, title: 'Ed thread' })
    await t.db.query(
      `INSERT INTO app.share_links (workspace_id, created_by, kind, target_id, title, token_hash, token_sealed, snapshot) VALUES ($1, $2, 'conversation', $3, 'x', 'hash-ed', 'sealed', '{}'::jsonb)`,
      [team.workspaceId, ed.id, conversation.id],
    )
    assert.equal(await repos.workspaces.removeMember(team.workspaceId, ed.id), 'ok')
    assert.equal(await repos.connectors.getConnection(team.workspaceId, connection.id), null)
    assert.equal(await repos.connectors.getSource(team.workspaceId, source.id), null)
    const [link] = await t.db.query<{ revoked_at: string | null }>(`SELECT revoked_at FROM app.share_links WHERE token_hash = 'hash-ed'`)
    assert.ok(link?.revoked_at, 'their public links are turned off')
  })

  it('keeps its place and retries through the job queue when the app is temporarily down', async () => {
    const app = fakeApp({ a: { version: '1' }, b: { version: '1', fail: 'outage' } })
    const { source } = await newSource('Outage')
    await repos.jobs.enqueue('sync_connector', { sourceId: source.id }, { maxAttempts: JOB_ATTEMPTS.sync_connector })
    await runJobs(
      { repos, ai: () => createFakeAi(), reranker: () => null, connectors: () => registryOf({ google_drive: app.connector }), secret: () => SECRET },
      { types: ['sync_connector'] },
    )
    const [job] = await t.db.query<{ status: string }>(`SELECT status FROM app.jobs WHERE type = 'sync_connector'`)
    assert.equal(job?.status, 'queued', 'retried later')
    assert.equal((await repos.connectors.sourceForSync(source.id))?.syncState?.index, 1, 'the next attempt starts at the failed item')
  })

  it('queues scheduled syncs once they are due', async () => {
    const { source } = await newSource('Scheduled')
    await t.db.query(`UPDATE app.connector_sources SET status = 'idle', next_sync_at = now() - interval '1 minute' WHERE id = $1`, [source.id])
    assert.equal(await queueDueSyncs(repos, 3), 1)
    assert.equal(await queueDueSyncs(repos, 3), 0, 'claimed once')
    assert.ok(await repos.jobs.hasActive('sync_connector', { sourceId: source.id }))
  })
})
