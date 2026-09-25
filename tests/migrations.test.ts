import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { runMigrations } from '@/server/db/migrate'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '@/server/db/migrations'
import { vectorLiteral } from '@/server/repositories/sql'
import { createRepositories } from '@/server/repositories'

import { createTestDb, type TestDb } from './helpers/db'
import { fakeEmbedding } from './helpers/fake-ai'

/**
 * Upgrading an existing database: data written under schema v1 (per-user ownership) must land in
 * each user's personal workspace, with nothing lost and nothing shared between users.
 */

let t: TestDb
const ids = {
  ann: 'a0000000-0000-4000-8000-000000000001',
  ben: 'b0000000-0000-4000-8000-000000000002',
  annNotebook: 'a0000000-0000-4000-8000-000000000011',
  benNotebook: 'b0000000-0000-4000-8000-000000000012',
  annDoc: 'a0000000-0000-4000-8000-000000000021',
  benDoc: 'b0000000-0000-4000-8000-000000000022',
  annConversation: 'a0000000-0000-4000-8000-000000000031',
}

before(async () => {
  t = await createTestDb({ migrate: false })
  const v1 = MIGRATIONS.find((migration) => migration.version === 1)!
  await t.db.query('CREATE SCHEMA app')
  await t.db.query(`CREATE TABLE app.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`)
  await t.db.transaction([...v1.statements.map((text) => ({ text })), { text: `INSERT INTO app.schema_migrations (version, name) VALUES (1, 'initial_schema')` }])

  const q = (text: string, params: unknown[] = []) => t.db.query(text, params)
  await q(`INSERT INTO app.users (id, email) VALUES ($1, 'ann@example.com'), ($2, 'ben@example.com')`, [ids.ann, ids.ben])
  // Both users had a notebook with the same name, which v1 allowed (unique per owner).
  await q(`INSERT INTO app.collections (id, owner_id, name) VALUES ($1, $2, 'General'), ($3, $4, 'General')`, [ids.annNotebook, ids.ann, ids.benNotebook, ids.ben])
  await q(
    `INSERT INTO app.documents (id, owner_id, collection_id, source_type, source, title, status, chunk_count, char_count)
     VALUES ($1, $2, $3, 'text', 'a', 'Ann doc', 'ready', 1, 20), ($4, $5, $6, 'text', 'b', 'Ben doc', 'ready', 1, 20)`,
    [ids.annDoc, ids.ann, ids.annNotebook, ids.benDoc, ids.ben, ids.benNotebook],
  )
  await q(
    `INSERT INTO app.chunks (document_id, owner_id, collection_id, chunk_index, content, embedding)
     VALUES ($1, $2, $3, 0, 'ann private tulips', $4::vector), ($5, $6, $7, 0, 'ben private tulips', $8::vector)`,
    [
      ids.annDoc,
      ids.ann,
      ids.annNotebook,
      vectorLiteral(fakeEmbedding('ann private tulips')),
      ids.benDoc,
      ids.ben,
      ids.benNotebook,
      vectorLiteral(fakeEmbedding('ben private tulips')),
    ],
  )
  await q(`INSERT INTO app.conversations (id, owner_id, collection_id, title) VALUES ($1, $2, $3, 'Ann chat')`, [ids.annConversation, ids.ann, ids.annNotebook])
  await q(`INSERT INTO app.messages (conversation_id, role, content) VALUES ($1, 'user', 'hello')`, [ids.annConversation])
  await q(`INSERT INTO app.query_logs (owner_id, mode, query, latency_ms, chunks_retrieved, status) VALUES ($1, 'standard', 'old question', 10, 1, 'ok')`, [ids.ann])

  const result = await runMigrations(t.db)
  assert.deepEqual(
    result.applied,
    MIGRATIONS.filter((migration) => migration.version > 1).map((migration) => migration.version),
  )
})

after(() => t.close())

describe('schema upgrade from v1', () => {
  it('reaches the latest version', async () => {
    const [row] = await t.db.query<{ v: number }>('SELECT max(version)::int AS v FROM app.schema_migrations')
    assert.equal(row?.v, LATEST_SCHEMA_VERSION)
  })

  it('moves each user’s data into their own personal workspace', async () => {
    const repos = createRepositories(t.db)
    for (const [user, notebook, doc, content] of [
      [ids.ann, ids.annNotebook, ids.annDoc, 'ann private tulips'],
      [ids.ben, ids.benNotebook, ids.benDoc, 'ben private tulips'],
    ] as const) {
      const [workspace] = await repos.workspaces.listForUser(user)
      assert.equal(workspace?.isPersonal, true)
      assert.equal(workspace?.role, 'admin')
      assert.equal(await repos.workspaces.ensurePersonal(user), workspace!.id, 'no second personal workspace')
      assert.deepEqual(
        (await repos.collections.list(workspace!.id, user)).map((c) => [c.id, c.documentCount]),
        [[notebook, 1]],
      )
      assert.equal((await repos.documents.get(workspace!.id, doc))?.title.endsWith('doc'), true)
      const hits = await repos.documents.vectorSearch({ workspaceId: workspace!.id, collectionId: null, embedding: fakeEmbedding('private tulips'), limit: 10 })
      assert.deepEqual(
        hits.map((hit) => hit.content),
        [content],
        'search sees only this user’s chunks',
      )
    }
  })

  it('keeps conversations, messages, query logs and authorship', async () => {
    const repos = createRepositories(t.db)
    const [annWorkspace] = await repos.workspaces.listForUser(ids.ann)
    const conversations = await repos.conversations.list(annWorkspace!.id, ids.ann)
    assert.deepEqual(
      conversations.map((c) => c.id),
      [ids.annConversation],
    )
    assert.equal((await repos.conversations.messages(ids.annConversation)).length, 1)
    const analytics = await repos.analytics.summary({ workspaceId: annWorkspace!.id, ownerId: ids.ann })
    assert.equal(analytics.totals.queries, 1)
    const [row] = await t.db.query<{ created_by: string }>('SELECT created_by FROM app.documents WHERE id = $1', [ids.annDoc])
    assert.equal(row?.created_by, ids.ann)
  })

  it('makes notebook names unique per workspace instead of per owner', async () => {
    const repos = createRepositories(t.db)
    const [annWorkspace] = await repos.workspaces.listForUser(ids.ann)
    assert.equal(await repos.collections.create(annWorkspace!.id, ids.ann, 'general'), null)
    assert.ok(await repos.collections.create(annWorkspace!.id, ids.ann, 'Research'))
  })

  it('deleting a user keeps their shared content but removes their personal workspace', async () => {
    const repos = createRepositories(t.db)
    const team = await repos.workspaces.create('Shared', ids.ben)
    await repos.workspaces.addMember(team.id, ids.ann, 'admin')
    const notebook = await repos.collections.create(team.id, ids.ben, 'Team notes')
    await t.db.query('DELETE FROM app.users WHERE id = $1', [ids.ben])
    assert.equal((await repos.collections.list(team.id, ids.ann)).find((c) => c.id === notebook!.id)?.name, 'Team notes')
    const [left] = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.chunks WHERE content = $1', ['ben private tulips'])
    assert.equal(left?.n, 0)
  })
})
