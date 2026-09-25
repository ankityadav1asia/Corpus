import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import { signToken } from '@/server/auth/session'
import { createGitHubConnector, parseRepository } from '@/server/connectors/github'
import { createGoogleDriveConnector } from '@/server/connectors/google-drive'
import { completeDriveAuthorization } from '@/server/connectors/google-oauth'
import { blockToMarkdown, createNotionConnector, pageTitle } from '@/server/connectors/notion'
import { registryOf } from '@/server/connectors/registry'
import { MAX_SYNC_ITEMS, queueDueSyncs, syncConnectorSource } from '@/server/connectors/sync'
import { ConnectorError, type Connector, type ConnectorContext, type FetchedItem, type SyncItem } from '@/server/connectors/types'
import { createWebsiteConnector, defaultPrefix, linksIn, parseRobots } from '@/server/connectors/website'
import { resetEnvCache } from '@/server/env'
import { Errors } from '@/server/http/errors'
import { PermanentJobError } from '@/server/jobs/errors'
import { runJobs } from '@/server/jobs/runner'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { SecretUnreadableError, openSecret, sealSecret } from '@/server/security/secrets'
import type { FetchedPage } from '@/server/security/ssrf'

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

describe('Notion', () => {
  it('turns pages into Markdown', () => {
    assert.equal(pageTitle({ object: 'page', id: '1', properties: { Name: { type: 'title', title: [{ plain_text: 'Roadmap' }] } } }), 'Roadmap')
    assert.equal(pageTitle({ object: 'database', id: '2', title: [{ plain_text: 'Tasks' }] }), 'Tasks')
    const rich = (text: string) => ({ rich_text: [{ plain_text: text }] })
    assert.equal(blockToMarkdown({ id: 'a', type: 'heading_2', heading_2: rich('Goals') }, ''), '## Goals')
    assert.equal(blockToMarkdown({ id: 'b', type: 'to_do', to_do: { ...rich('Ship it'), checked: true } }, '  '), '  - [x] Ship it')
    assert.equal(blockToMarkdown({ id: 'c', type: 'code', code: { ...rich('npm test'), language: 'bash' } }, ''), '```bash\nnpm test\n```')
    assert.equal(blockToMarkdown({ id: 'd', type: 'table_row', table_row: { cells: [[{ plain_text: 'a|b' }], [{ plain_text: 'c' }]] } }, ''), '| a\\|b | c |')
    assert.equal(blockToMarkdown({ id: 'e', type: 'paragraph', paragraph: rich('') }, ''), null)
  })

  it('syncs every page of a database and reads nested blocks', async () => {
    const { requests, fetchImpl } = mockFetch((url) => {
      if (url.includes('/databases/db1/query')) {
        const second = requests.filter((request) => request.url.includes('/query')).length > 1
        return Response.json(
          second
            ? { results: [{ object: 'page', id: 'p2', last_edited_time: 't2', properties: { t: { type: 'title', title: [{ plain_text: 'Two' }] } } }], has_more: false }
            : {
                results: [{ object: 'page', id: 'p1', last_edited_time: 't1', url: 'https://notion.so/p1', properties: { t: { type: 'title', title: [{ plain_text: 'One' }] } } }],
                has_more: true,
                next_cursor: 'c2',
              },
        )
      }
      if (url.includes('/blocks/p1/children')) {
        return Response.json({
          results: [{ id: 'b1', type: 'bulleted_list_item', has_children: true, bulleted_list_item: { rich_text: [{ plain_text: 'Parent' }] } }],
          has_more: false,
        })
      }
      if (url.includes('/blocks/b1/children'))
        return Response.json({ results: [{ id: 'b2', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Nested detail' }] } }], has_more: false })
      return new Response('{}', { status: 404 })
    })
    const notion = createNotionConnector()
    const { context } = contextWith(fetchImpl, { token: 'ntn_x' })
    const items = await notion.list(context, { externalId: 'db1', kind: 'database', name: 'Tasks', options: {} }, 50)
    assert.deepEqual(
      items.map((item) => [item.externalId, item.version, item.title]),
      [
        ['p1', 't1', 'One'],
        ['p2', 't2', 'Two'],
      ],
    )
    const fetched = await notion.fetchItem(context, items[0]!, { externalId: 'db1', kind: 'database', name: 'Tasks', options: {} })
    assert.equal(fetched.type, 'text')
    assert.equal(fetched.type === 'text' && fetched.text, '# One\n\n- Parent\n\n  Nested detail')
    assert.equal((requests[0]!.init.headers as Record<string, string>)['Notion-Version'], '2022-06-28')
  })

  it('reports a revoked token as an access problem', async () => {
    const notion = createNotionConnector()
    const { context } = contextWith(mockFetch(() => new Response('{}', { status: 401 })).fetchImpl, { token: 'bad' })
    await assert.rejects(notion.browse(context, { parentId: null, query: 'x', cursor: null }), (error: unknown) => error instanceof ConnectorError && error.auth)
  })
})

describe('GitHub', () => {
  it('accepts owner/name or a URL and rejects anything else', () => {
    assert.deepEqual(parseRepository('https://github.com/vercel/next.js.git'), { owner: 'vercel', repo: 'next.js' })
    assert.deepEqual(parseRepository(' acme/docs/ '), { owner: 'acme', repo: 'docs' })
    assert.throws(() => parseRepository('../../etc'), ConnectorError)
    assert.throws(() => parseRepository('https://evil.example/a/b'), ConnectorError)
  })

  it('syncs documentation files under a folder and reads them from the raw host', async () => {
    const { requests, fetchImpl } = mockFetch((url) => {
      if (url === 'https://api.github.com/repos/acme/handbook')
        return Response.json({ full_name: 'acme/handbook', html_url: 'https://github.com/acme/handbook', default_branch: 'main' })
      if (url.includes('/git/trees/main?recursive=1')) {
        return Response.json({
          tree: [
            { path: 'docs/intro.md', type: 'blob', sha: 'a1', size: 100 },
            { path: 'docs/deep/setup.rst', type: 'blob', sha: 'b2', size: 100 },
            { path: 'docs/logo.png', type: 'blob', sha: 'c3', size: 100 },
            { path: 'src/index.ts', type: 'blob', sha: 'd4', size: 100 },
            { path: 'docs/huge.md', type: 'blob', sha: 'e5', size: 5_000_000 },
            { path: 'docs', type: 'tree', sha: 'f6' },
          ],
        })
      }
      if (url.startsWith('https://raw.githubusercontent.com/acme/handbook/main/docs/intro.md')) return new Response('# Intro\n\nWelcome.')
      return new Response('{}', { status: 404 })
    })
    const github = createGitHubConnector()
    const { context } = contextWith(fetchImpl, { token: 'ghp_x' })
    const source = { externalId: 'acme/handbook', kind: 'repository' as const, name: 'acme/handbook', options: { path: '/docs/' } }
    const items = await github.list(context, source, 100)
    assert.deepEqual(
      items.map((item) => item.meta?.path),
      ['docs/intro.md', 'docs/deep/setup.rst'],
    )
    assert.equal(items[0]!.url, 'https://github.com/acme/handbook/blob/main/docs/intro.md')
    const fetched = await github.fetchItem(context, items[0]!, source)
    assert.equal(fetched.type === 'text' && fetched.text, '# Intro\n\nWelcome.')
    assert.equal((requests.at(-1)!.init.headers as Record<string, string>).Authorization, 'Bearer ghp_x')
    assert.deepEqual(
      await github.browse(contextWith(fetchImpl).context, { parentId: null, query: null, cursor: null }),
      { items: [], nextCursor: null },
      'without a token only named repositories can be added',
    )
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

describe('websites', () => {
  const html = (links: string[], body = 'Useful documentation text that is long enough to index properly.') =>
    `<html><head><title>Docs</title></head><body><main><p>${body}</p>${links.map((link) => `<a href="${link}">x</a>`).join('')}</main></body></html>`

  function site(pages: Record<string, string>, extra: Record<string, FetchedPage> = {}) {
    const fetched: string[] = []
    const fetchPage = async (url: string): Promise<FetchedPage> => {
      fetched.push(url)
      if (extra[url]) return extra[url]
      const body = pages[url]
      if (body === undefined) throw Errors.unprocessable('not found')
      return { url, contentType: 'text/html', body }
    }
    return { fetched, connector: createWebsiteConnector({ fetchPage }) }
  }

  it('parses robots.txt rules for all agents and resolves links', () => {
    assert.deepEqual(parseRobots('User-agent: bot\nDisallow: /all\n\nUser-agent: *\nDisallow: /private # secret\nAllow: /public\nDisallow:'), ['/private'])
    assert.equal(defaultPrefix(new URL('https://docs.example.com/guide/start')), '/guide/')
    assert.deepEqual(linksIn('<a href="../b#top">b</a><a href="mailto:x@y.z">m</a>', 'https://e.com/a/c'), ['https://e.com/b'])
  })

  it('crawls pages under the start path on the same site, respecting robots.txt and the page limit', async () => {
    const { fetched, connector } = site(
      {
        'https://docs.example.com/guide/': html(['/guide/a', '/guide/b', '/blog/news', 'https://other.example.com/guide/x', '/guide/private/secret', '/guide/file.pdf']),
        'https://docs.example.com/guide/a': html(['/guide/c']),
        'https://docs.example.com/guide/b': html([]),
        'https://docs.example.com/guide/c': html([]),
      },
      { 'https://docs.example.com/robots.txt': { url: 'https://docs.example.com/robots.txt', contentType: 'text/plain', body: 'User-agent: *\nDisallow: /guide/private' } },
    )
    const { context } = contextWith(fetch)
    const source = { externalId: 'https://docs.example.com/guide/', kind: 'site' as const, name: 'Docs', options: { maxPages: 3 } }
    const items = await connector.list(context, source, MAX_SYNC_ITEMS)
    assert.deepEqual(
      items.map((item) => item.externalId),
      ['https://docs.example.com/guide/', 'https://docs.example.com/guide/a', 'https://docs.example.com/guide/b'],
    )
    const before = fetched.length
    const page = await connector.fetchItem(context, items[1]!, source)
    assert.equal(fetched.length, before, 'crawled pages are reused, not fetched twice')
    assert.equal(page.type === 'text' && page.title, 'Docs')
    const again = await connector.fetchItem(context, items[1]!, source)
    assert.equal(page.version, again.version)
    assert.match(page.version ?? '', /^[0-9a-f]{32}$/)
  })

  it('prefers the sitemap when there is one', async () => {
    const { connector } = site(
      { 'https://e.com/docs/': html([]) },
      {
        'https://e.com/sitemap.xml': {
          url: 'https://e.com/sitemap.xml',
          contentType: 'application/xml',
          body: '<urlset><url><loc>https://e.com/docs/a</loc></url><url><loc>https://e.com/other</loc></url><url><loc>https://e.com/docs/b?x=1&amp;y=2</loc></url></urlset>',
        },
      },
    )
    const items = await connector.list(contextWith(fetch).context, { externalId: 'https://e.com/docs/', kind: 'site', name: 'E', options: {} }, 50)
    assert.deepEqual(
      items.map((item) => item.externalId),
      ['https://e.com/docs/', 'https://e.com/docs/a', 'https://e.com/docs/b?x=1&y=2'],
    )
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
      id: 'notion',
      async browse() {
        return { items: [], nextCursor: null }
      },
      async list() {
        return Object.entries(items).map(([id, item]): SyncItem => ({ externalId: id, version: item.version, title: `Page ${id}`, url: `https://notion.so/${id}` }))
      },
      async fetchItem(_context, item): Promise<FetchedItem> {
        fetched.push(item.externalId)
        const entry = items[item.externalId]!
        if (entry.fail === 'bad') throw new ConnectorError('This page type is not supported.')
        if (entry.fail === 'auth') throw new ConnectorError('Notion refused access (401).', 401, false, true)
        if (entry.fail === 'outage') throw new ConnectorError('Notion request failed (503)', 503, true)
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
      provider: 'notion',
      accountLabel: `Workspace ${name}`,
      credentials: await sealSecret(JSON.stringify({ token: 'ntn_x' }), SECRET),
    })
    const source = await repos.connectors.saveSource({
      workspaceId: owner.workspaceId,
      collectionId: owner.notebookId,
      connectionId: connection.id,
      createdBy: owner.id,
      provider: 'notion',
      kind: 'database',
      externalId: `db-${name}`,
      name,
      url: null,
      options: {},
      autoSync: true,
      syncIntervalHours: 24,
    })
    return { source, connection }
  }

  const deps = (connector: Connector) => ({ repos, connectors: registryOf({ notion: connector }), secret: SECRET })
  const index = () =>
    runJobs({ repos, ai: () => createFakeAi(), reranker: () => createLlmReranker(createFakeAi()), images: () => null }, { maxJobs: 50, types: ['ingest_document', 'read_media'] })
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
        ['a', 'ready', 'notion'],
        ['b', 'ready', 'notion'],
        ['c', 'ready', 'notion'],
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
    assert.match(summary?.lastError ?? '', /1 item could not be imported: Page bad: This page type is not supported/)
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
      provider: 'notion',
      accountLabel: 'Ed Notion',
      credentials: await sealSecret(JSON.stringify({ token: 'ntn_x' }), SECRET),
    })
    const source = await repos.connectors.saveSource({
      workspaceId: team.workspaceId,
      collectionId: team.notebookId,
      connectionId: connection.id,
      createdBy: ed.id,
      provider: 'notion',
      kind: 'database',
      externalId: 'db-team',
      name: 'Team wiki',
      url: null,
      options: {},
      autoSync: true,
      syncIntervalHours: 24,
    })
    const app = fakeApp({ a: { version: '1' } })
    assert.equal(await syncConnectorSource(deps(app.connector), source.id, Date.now() + 60_000), 'done')

    // Demoted to viewer: the next scheduled sync stops instead of using Ed's Notion access.
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
      { repos, ai: () => createFakeAi(), reranker: () => null, images: () => null, connectors: () => registryOf({ notion: app.connector }), secret: () => SECRET },
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
