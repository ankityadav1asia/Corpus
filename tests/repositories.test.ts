import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { runMigrations } from '@/server/db/migrate'
import { LATEST_SCHEMA_VERSION } from '@/server/db/migrations'
import { createRepositories, type Repositories } from '@/server/repositories'
import { STALE_LOCK_SECONDS } from '@/server/repositories/jobs'

import { createTestDb, type TestDb } from './helpers/db'
import { fakeEmbedding } from './helpers/fake-ai'
import { addDocument, createTeam, createUser, type TestUser } from './helpers/fixtures'

let t: TestDb
let repos: Repositories
let alice: TestUser
let bob: TestUser

before(async () => {
  t = await createTestDb()
  repos = createRepositories(t.db)
  alice = await createUser(repos, 'Alice@Example.com', 'Alice')
  bob = await createUser(repos, 'bob@example.com')
})

after(() => t.close())

const doc = (owner: TestUser, title: string, chunks: string[], extra: { ready?: boolean; collectionId?: string; workspaceId?: string } = {}) =>
  addDocument(repos, {
    workspaceId: extra.workspaceId ?? owner.workspaceId,
    collectionId: extra.collectionId ?? owner.notebookId,
    createdBy: owner.id,
    title,
    chunks,
    ready: extra.ready,
  })

describe('migrations', () => {
  it('are idempotent and record the schema version', async () => {
    const second = await runMigrations(t.db)
    assert.deepEqual(second.applied, [])
    const [row] = await t.db.query<{ v: number }>('SELECT max(version)::int AS v FROM app.schema_migrations')
    assert.equal(row?.v, LATEST_SCHEMA_VERSION)
  })
})

describe('users', () => {
  it('upserts by normalised email and reports whether the row was created', async () => {
    const again = await repos.users.upsertOnLogin('ALICE@example.com', null)
    assert.equal(again.created, false)
    assert.equal(again.user.id, alice.id)
    assert.equal(again.user.email, 'alice@example.com')
    assert.equal(again.user.name, 'Alice', 'a null name must not erase the stored one')
    const fresh = await repos.users.upsertOnLogin('carol@example.com', 'Carol')
    assert.equal(fresh.created, true)
  })
})

describe('workspaces', () => {
  it('ensurePersonal is idempotent and makes the user its admin', async () => {
    assert.equal(await repos.workspaces.ensurePersonal(alice.id), alice.workspaceId)
    const [results] = await Promise.all([Promise.all([repos.workspaces.ensurePersonal(bob.id), repos.workspaces.ensurePersonal(bob.id)])])
    assert.deepEqual(results, [bob.workspaceId, bob.workspaceId])
    const list = await repos.workspaces.listForUser(alice.id)
    assert.equal(list[0]?.id, alice.workspaceId)
    assert.equal(list[0]?.isPersonal, true)
    assert.equal(list[0]?.role, 'admin')
    assert.deepEqual(await repos.workspaces.membership(alice.workspaceId, bob.id), null)
  })

  it('stored settings are parsed with defaults and survive unknown or invalid keys', async () => {
    const defaults = await repos.workspaces.settings(alice.workspaceId)
    assert.equal(defaults.retrieval.rerank, true)
    assert.equal(defaults.retrieval.candidatePool, 20)
    assert.equal(defaults.retrieval.topK, 5)
    assert.equal(defaults.guardrail.minRelevance, 0.35)
    await t.db.query(`UPDATE app.workspaces SET settings = $2::jsonb WHERE id = $1`, [bob.workspaceId, JSON.stringify({ retrieval: { topK: 99 }, junk: true })])
    assert.equal((await repos.workspaces.settings(bob.workspaceId)).retrieval.topK, 5, 'invalid stored values fall back to defaults')
    await t.db.query(`UPDATE app.workspaces SET settings = '{}'::jsonb WHERE id = $1`, [bob.workspaceId])
  })

  it('never lets the last admin leave or be demoted, even when two admins race', async () => {
    const carol = await createUser(repos, 'carol-ws@example.com')
    const team = await createTeam(repos, alice, [
      [carol, 'admin'],
      [bob, 'viewer'],
    ])
    // Two admins demote each other at the same time: at most one may succeed.
    const results = await Promise.all([repos.workspaces.setRole(team.workspaceId, alice.id, 'editor'), repos.workspaces.setRole(team.workspaceId, carol.id, 'editor')])
    assert.equal(results.filter((r) => r === 'ok').length, 1)
    assert.equal(results.filter((r) => r === 'last_admin').length, 1)
    const remainingAdmin = results[0] === 'ok' ? carol : alice
    assert.equal(await repos.workspaces.removeMember(team.workspaceId, remainingAdmin.id), 'last_admin')
    assert.equal(await repos.workspaces.setRole(team.workspaceId, remainingAdmin.id, 'viewer'), 'last_admin')
    assert.equal(await repos.workspaces.setRole(team.workspaceId, bob.id, 'editor'), 'ok')
    assert.equal(await repos.workspaces.removeMember(team.workspaceId, bob.id), 'ok')
    assert.equal(await repos.workspaces.removeMember(team.workspaceId, bob.id), 'not_found')
  })

  it('removing a member also drops their notebook role overrides', async () => {
    const dave = await createUser(repos, 'dave@example.com')
    const team = await createTeam(repos, alice, [[dave, 'viewer']])
    await repos.collections.setRoleOverride(team.notebookId, dave.id, 'editor')
    assert.equal((await repos.collections.get(team.workspaceId, team.notebookId, dave.id))?.override, 'editor')
    assert.equal(await repos.workspaces.removeMember(team.workspaceId, dave.id), 'ok')
    assert.deepEqual(await repos.collections.roleOverrides(team.notebookId), [])
  })

  it('invitations are case-insensitive and turn into memberships on sign-in', async () => {
    const team = await createTeam(repos, alice)
    await repos.workspaces.upsertInvite(team.workspaceId, 'New.Person@Example.com', 'viewer', alice.id)
    await repos.workspaces.upsertInvite(team.workspaceId, 'new.person@example.com', 'editor', alice.id)
    assert.deepEqual(
      (await repos.workspaces.invites(team.workspaceId)).map((invite) => [invite.email, invite.role]),
      [['new.person@example.com', 'editor']],
    )
    const newcomer = (await repos.users.upsertOnLogin('new.person@example.com', null)).user
    assert.equal(await repos.workspaces.acceptInvites(newcomer.id, newcomer.email), 1)
    assert.equal((await repos.workspaces.membership(team.workspaceId, newcomer.id))?.role, 'editor')
    assert.deepEqual(await repos.workspaces.invites(team.workspaceId), [])
    assert.equal(await repos.workspaces.acceptInvites(newcomer.id, newcomer.email), 0)
  })

  it('personal workspaces cannot be deleted; team workspaces cascade to their content', async () => {
    assert.equal(await repos.workspaces.delete(alice.workspaceId), false)
    const team = await createTeam(repos, alice)
    await doc(alice, 'Team doc', ['team content'], { workspaceId: team.workspaceId, collectionId: team.notebookId })
    assert.equal(await repos.workspaces.delete(team.workspaceId), true)
    const [row] = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.chunks WHERE workspace_id = $1', [team.workspaceId])
    assert.equal(row?.n, 0)
  })
})

describe('collections', () => {
  it('ensureDefault creates exactly one notebook per workspace', async () => {
    await repos.collections.ensureDefault(alice.workspaceId, alice.id)
    const list = await repos.collections.list(alice.workspaceId, alice.id)
    assert.equal(list.length, 1)
    assert.equal(list[0]!.name, 'General')
  })

  it('names are unique per workspace (case-insensitive) but not across workspaces', async () => {
    const research = await repos.collections.create(alice.workspaceId, alice.id, 'Research')
    assert.ok(research)
    assert.equal(await repos.collections.create(alice.workspaceId, alice.id, 'research'), null)
    assert.ok(await repos.collections.create(bob.workspaceId, bob.id, 'Research'))
    assert.equal(await repos.collections.rename(alice.workspaceId, alice.notebookId, 'RESEARCH'), 'conflict')
    assert.equal(await repos.collections.rename(alice.workspaceId, research!.id, 'Papers'), 'ok')
  })

  it('a notebook id from another workspace is invisible and untouchable', async () => {
    assert.equal(await repos.collections.get(bob.workspaceId, alice.notebookId, bob.id), null)
    assert.equal(await repos.collections.rename(bob.workspaceId, alice.notebookId, 'pwned'), 'not_found')
    assert.equal(await repos.collections.delete(bob.workspaceId, alice.notebookId), false)
    assert.ok((await repos.collections.list(bob.workspaceId, bob.id)).every((c) => c.id !== alice.notebookId))
  })
})

describe('documents, chunks and search', () => {
  it('hybrid search sources are workspace- and notebook-scoped and exclude processing documents', async () => {
    await doc(alice, 'Neon notes', ['Neon is serverless postgres with branching', 'Branching creates copies of a database'])
    await doc(bob, 'Bob secret', ['serverless postgres secret plans of bob'])
    await doc(alice, 'Half ingested', ['serverless postgres half ingested'], { ready: false })

    const scope = { workspaceId: alice.workspaceId, collectionId: alice.notebookId }
    const vector = await repos.documents.vectorSearch({ ...scope, embedding: fakeEmbedding('serverless postgres'), limit: 10 })
    assert.ok(vector.length >= 1)
    assert.ok(
      vector.every((hit) => hit.title === 'Neon notes'),
      'no foreign or processing documents',
    )
    assert.equal(vector[0]!.content, 'Neon is serverless postgres with branching')
    assert.ok(vector[0]!.similarity! > 0.5)

    const keyword = await repos.documents.keywordSearch({ workspaceId: alice.workspaceId, collectionId: null, query: 'branching', limit: 10 })
    assert.deepEqual(
      keyword.map((hit) => hit.title),
      ['Neon notes', 'Neon notes'],
    )
    const bobHits = await repos.documents.keywordSearch({ workspaceId: bob.workspaceId, collectionId: null, query: 'serverless postgres', limit: 10 })
    assert.deepEqual(
      bobHits.map((hit) => hit.title),
      ['Bob secret'],
    )
    const crossed = await repos.documents.vectorSearch({ workspaceId: bob.workspaceId, collectionId: alice.notebookId, embedding: fakeEmbedding('postgres'), limit: 10 })
    assert.equal(crossed.length, 0, 'a foreign notebook id inside your workspace scope finds nothing')
  })

  it('keyword search accepts arbitrary user input without SQL or tsquery errors', async () => {
    for (const query of [`'; DROP TABLE app.chunks; --`, '"unbalanced', 'a & | ! ( )', '%_\\', '']) {
      await repos.documents.keywordSearch({ workspaceId: alice.workspaceId, collectionId: null, query, limit: 5 })
    }
    const [row] = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.chunks')
    assert.ok(row!.n > 0)
  })

  it('chunk explorer paginates, filters and matches search text literally', async () => {
    await doc(alice, 'Percent doc', ['growth was 100% this year', 'growth was 1000 units'])
    const literal = await repos.chunks.list({ workspaceId: alice.workspaceId, q: '100%', page: 0, pageSize: 10 })
    assert.deepEqual(
      literal.items.map((item) => item.content),
      ['growth was 100% this year'],
    )
    const page0 = await repos.chunks.list({ workspaceId: alice.workspaceId, collectionId: alice.notebookId, page: 0, pageSize: 2 })
    const page1 = await repos.chunks.list({ workspaceId: alice.workspaceId, collectionId: alice.notebookId, page: 1, pageSize: 2 })
    assert.equal(page0.items.length, 2)
    assert.equal(page0.total, page1.total)
    assert.notDeepEqual(
      page0.items.map((i) => i.id),
      page1.items.map((i) => i.id),
    )
    const bobView = await repos.chunks.list({ workspaceId: bob.workspaceId, collectionId: alice.notebookId, page: 0, pageSize: 50 })
    assert.equal(bobView.total, 0, 'another workspace’s notebook id yields nothing')
  })

  it('edits text, labels and metadata in place; the vector and full-text index follow the text', async () => {
    const document = await doc(alice, 'Editable', ['original wording about turbines', 'second chunk'])
    const [first] = (await repos.chunks.list({ workspaceId: alice.workspaceId, documentId: document.id, page: 0, pageSize: 5 })).items
    const updated = await repos.chunks.update(
      alice.workspaceId,
      first!.id,
      {
        content: 'revised wording about windmills',
        embedding: fakeEmbedding('revised wording about windmills'),
        labels: ['energy', 'draft'],
        metadata: { page: 3, reviewed: true },
      },
      alice.id,
    )
    assert.equal(updated?.content, 'revised wording about windmills')
    assert.deepEqual(updated?.labels, ['energy', 'draft'])
    assert.deepEqual(updated?.metadata, { page: 3, reviewed: true })
    assert.ok(updated?.updatedAt)

    const keyword = await repos.documents.keywordSearch({ workspaceId: alice.workspaceId, collectionId: null, query: 'windmills', limit: 5 })
    assert.equal(keyword[0]?.chunkId, first!.id)
    assert.equal((await repos.documents.keywordSearch({ workspaceId: alice.workspaceId, collectionId: null, query: 'turbines', limit: 5 })).length, 0)
    const vector = await repos.documents.vectorSearch({ workspaceId: alice.workspaceId, collectionId: alice.notebookId, embedding: fakeEmbedding('windmills'), limit: 1 })
    assert.equal(vector[0]?.chunkId, first!.id)
    assert.equal((await repos.documents.get(alice.workspaceId, document.id))?.charCount, 'revised wording about windmills'.length + 'second chunk'.length)

    // Labels-only edits keep the text and vector.
    const relabeled = await repos.chunks.update(alice.workspaceId, first!.id, { labels: ['final'] }, alice.id)
    assert.equal(relabeled?.content, 'revised wording about windmills')
    const byLabel = await repos.chunks.list({ workspaceId: alice.workspaceId, label: 'final', page: 0, pageSize: 10 })
    assert.deepEqual(
      byLabel.items.map((item) => item.id),
      [first!.id],
    )
    assert.equal(await repos.chunks.update(bob.workspaceId, first!.id, { labels: ['x'] }, bob.id), null, 'other workspaces cannot edit it')

    const detail = await repos.chunks.get(alice.workspaceId, first!.id)
    assert.equal(detail?.embedding.dimensions, 3072)
    assert.ok(Math.abs(detail!.embedding.norm - 1) < 0.01)
    assert.equal(detail?.embedding.preview.length, 8)
    assert.equal(await repos.chunks.get(bob.workspaceId, first!.id), null)
  })

  it('appends chunks at the end of ready documents only and keeps counts right', async () => {
    const document = await doc(alice, 'Appendable', ['one', 'two'])
    const added = await repos.chunks.append(alice.workspaceId, document.id, { content: 'three', embedding: fakeEmbedding('three'), labels: ['manual'], metadata: {} }, alice.id)
    assert.equal(added?.chunkIndex, 2)
    assert.equal((await repos.documents.get(alice.workspaceId, document.id))?.chunkCount, 3)
    const processing = await doc(alice, 'Processing', ['x'], { ready: false })
    assert.equal(await repos.chunks.append(alice.workspaceId, processing.id, { content: 'y', embedding: fakeEmbedding('y'), labels: [], metadata: {} }, alice.id), null)
    assert.equal(await repos.chunks.append(bob.workspaceId, document.id, { content: 'z', embedding: fakeEmbedding('z'), labels: [], metadata: {} }, bob.id), null)
  })

  it('deleting a chunk keeps counts consistent and respects the workspace', async () => {
    const document = await doc(alice, 'Counted', ['one piece', 'two piece'])
    const [chunk] = (await repos.chunks.list({ workspaceId: alice.workspaceId, documentId: document.id, page: 0, pageSize: 5 })).items
    assert.equal(await repos.chunks.delete(bob.workspaceId, chunk!.id), false)
    assert.equal(await repos.chunks.delete(alice.workspaceId, chunk!.id), true)
    assert.equal((await repos.documents.get(alice.workspaceId, document.id))?.chunkCount, 1)
  })

  it('re-ingest replaces older versions of the same source only', async () => {
    const first = await doc(alice, 'https://example.com/a', ['v1'])
    const second = await doc(alice, 'https://example.com/a', ['v2'])
    const other = await doc(alice, 'https://example.com/b', ['other'])
    assert.equal(await repos.documents.deleteOtherVersions(alice.workspaceId, second), 1)
    assert.equal(await repos.documents.get(alice.workspaceId, first.id), null)
    assert.ok(await repos.documents.get(alice.workspaceId, other.id))
  })

  it('deleting a notebook cascades to documents and chunks but keeps conversations', async () => {
    const temp = (await repos.collections.create(alice.workspaceId, alice.id, 'Temporary'))!
    const document = await doc(alice, 'temp doc', ['temporary text'], { collectionId: temp.id })
    const conversation = await repos.conversations.create({ workspaceId: alice.workspaceId, ownerId: alice.id, collectionId: temp.id, title: 'About temp' })
    assert.equal(await repos.collections.delete(alice.workspaceId, temp.id), true)
    assert.equal(await repos.documents.get(alice.workspaceId, document.id), null)
    const [orphans] = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.chunks WHERE document_id = $1', [document.id])
    assert.equal(orphans!.n, 0)
    assert.equal((await repos.conversations.get(alice.workspaceId, alice.id, conversation.id))?.collectionId, null)
  })

  it('report sources resolve within the workspace only and rebuild text in chunk order', async () => {
    const document = await doc(alice, 'Ordered', ['first part', 'second part', 'third part'])
    const resolved = await repos.documents.resolveReportDocuments(alice.workspaceId, { collectionIds: [], documentIds: [document.id] }, 10)
    assert.deepEqual(
      resolved.map((d) => d.id),
      [document.id],
    )
    assert.deepEqual(await repos.documents.resolveReportDocuments(bob.workspaceId, { collectionIds: [alice.notebookId], documentIds: [document.id] }, 10), [])
    const [text] = await repos.documents.documentTexts(alice.workspaceId, [document.id], 1000)
    assert.equal(text?.text, 'first part\n\nsecond part\n\nthird part')
    const [capped] = await repos.documents.documentTexts(alice.workspaceId, [document.id], 5)
    assert.equal(capped?.text, 'first')
  })

  it('totals only count ready documents of the workspace', async () => {
    const totals = await repos.documents.totals(bob.workspaceId)
    assert.equal(totals.documents, 1)
    assert.equal(totals.chunks, 1)
  })
})

describe('conversations', () => {
  it('stores messages in order, returns recent turns oldest-first and is private to its author', async () => {
    const conversation = await repos.conversations.create({ workspaceId: alice.workspaceId, ownerId: alice.id, collectionId: null, title: 'Thread' })
    for (let i = 0; i < 5; i++) {
      await repos.conversations.addMessage({ conversationId: conversation.id, role: i % 2 ? 'assistant' : 'user', content: `m${i}` })
    }
    assert.deepEqual(
      (await repos.conversations.messages(conversation.id)).map((m) => m.content),
      ['m0', 'm1', 'm2', 'm3', 'm4'],
    )
    assert.deepEqual(
      (await repos.conversations.recentTurns(conversation.id, 3)).map((m) => m.content),
      ['m2', 'm3', 'm4'],
    )
    assert.equal(await repos.conversations.get(bob.workspaceId, bob.id, conversation.id), null)
    assert.equal(await repos.conversations.get(alice.workspaceId, bob.id, conversation.id), null, 'workspace members cannot read each other’s chats')
    assert.equal(await repos.conversations.rename(alice.workspaceId, bob.id, conversation.id, 'x'), null)
    assert.equal(await repos.conversations.delete(alice.workspaceId, bob.id, conversation.id), false)
  })

  it('searches the author’s chats by title and message text, literally', async () => {
    const byTitle = await repos.conversations.create({ workspaceId: alice.workspaceId, ownerId: alice.id, collectionId: null, title: 'Quarterly Budget review' })
    const byMessage = await repos.conversations.create({ workspaceId: alice.workspaceId, ownerId: alice.id, collectionId: null, title: 'Untitled' })
    await repos.conversations.addMessage({ conversationId: byMessage.id, role: 'assistant', content: 'The budget grew 100% last year.' })
    const bobs = await repos.conversations.create({ workspaceId: bob.workspaceId, ownerId: bob.id, collectionId: null, title: 'Budget (bob)' })

    const found = await repos.conversations.search(alice.workspaceId, alice.id, 'budget')
    assert.deepEqual(new Set(found.map((c) => c.id)), new Set([byTitle.id, byMessage.id]))
    assert.ok(!found.some((c) => c.id === bobs.id), 'never another member’s chats')
    assert.deepEqual(
      (await repos.conversations.search(alice.workspaceId, alice.id, '100%')).map((c) => c.id),
      [byMessage.id],
    )
    assert.deepEqual(await repos.conversations.search(alice.workspaceId, alice.id, '_%'), [], 'wildcards are matched literally')
    assert.deepEqual(await repos.conversations.search(bob.workspaceId, alice.id, 'budget'), [], 'scoped to the workspace')
  })

  it('branches server-side up to the chosen message and never across owners', async () => {
    const conversation = await repos.conversations.create({ workspaceId: alice.workspaceId, ownerId: alice.id, collectionId: alice.notebookId, title: 'Original' })
    const messages = []
    for (const [role, content] of [
      ['user', 'q1'],
      ['assistant', 'a1'],
      ['user', 'q2'],
      ['assistant', 'a2'],
    ] as const) {
      messages.push(await repos.conversations.addMessage({ conversationId: conversation.id, role, content, citations: [] }))
    }
    assert.equal(await repos.conversations.branch(bob.workspaceId, bob.id, conversation.id, messages[1]!.id), null)
    assert.equal(await repos.conversations.branch(alice.workspaceId, bob.id, conversation.id, messages[1]!.id), null)

    const branchId = await repos.conversations.branch(alice.workspaceId, alice.id, conversation.id, messages[1]!.id)
    assert.ok(branchId)
    const branch = await repos.conversations.get(alice.workspaceId, alice.id, branchId!)
    assert.equal(branch?.parentId, conversation.id)
    assert.equal(branch?.title, '↳ Original')
    assert.deepEqual(
      (await repos.conversations.messages(branchId!)).map((m) => m.content),
      ['q1', 'a1'],
    )
    assert.equal((await repos.conversations.messages(conversation.id)).length, 4, 'source thread untouched')
  })

  it('finds the question an answer responded to, and attaches evaluation scores to messages', async () => {
    const conversation = await repos.conversations.create({ workspaceId: alice.workspaceId, ownerId: alice.id, collectionId: null, title: 'Scored' })
    await repos.conversations.addMessage({ conversationId: conversation.id, role: 'user', content: 'What is RRF?' })
    const answer = await repos.conversations.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'A fusion method [1].' })
    const target = await repos.conversations.questionFor(answer.id)
    assert.deepEqual(target && { question: target.question, answer: target.answer, workspaceId: target.workspaceId }, {
      question: 'What is RRF?',
      answer: 'A fusion method [1].',
      workspaceId: alice.workspaceId,
    })
    await repos.evaluations.save({
      workspaceId: alice.workspaceId,
      messageId: answer.id,
      question: 'What is RRF?',
      answer: 'A fusion method [1].',
      scores: { faithfulness: 1, answerRelevance: 0.75, contextPrecision: 0.5, contextRecall: null },
      details: {},
      model: 'test',
    })
    const [, stored] = await repos.conversations.messages(conversation.id)
    assert.deepEqual(stored?.evaluation, { faithfulness: 1, answerRelevance: 0.75, contextPrecision: 0.5, contextRecall: null })
  })
})

describe('background jobs', () => {
  it('hands each job to exactly one worker, retries with backoff and gives up after max attempts', async () => {
    await t.db.query('DELETE FROM app.jobs')
    const id = await repos.jobs.enqueue('generate_report', { reportId: 'r1' }, { maxAttempts: 2 })
    const claims = await Promise.all([repos.jobs.claim(), repos.jobs.claim(), repos.jobs.claim()])
    assert.equal(claims.filter(Boolean).length, 1)
    const job = claims.find(Boolean)!
    assert.equal(job.id, id)
    assert.equal(job.attempts, 1)
    assert.deepEqual(job.payload, { reportId: 'r1' })

    assert.equal(await repos.jobs.fail(id, 'boom', 60), 'queued')
    assert.equal(await repos.jobs.claim(), null, 'not before its retry delay')
    await t.db.query(`UPDATE app.jobs SET run_after = now() WHERE id = $1`, [id])
    const retry = await repos.jobs.claim()
    assert.equal(retry?.attempts, 2)
    assert.equal(await repos.jobs.fail(id, 'boom again', 0), 'failed')
    assert.equal(await repos.jobs.claim(), null)
    assert.deepEqual(await repos.jobs.status(id), { status: 'failed', attempts: 2, lastError: 'boom again' })
  })

  it('recovers jobs whose worker died, filters by type and purges old finished jobs', async () => {
    await t.db.query('DELETE FROM app.jobs')
    const stuck = await repos.jobs.enqueue('evaluate_answer', { messageId: 'm' })
    await repos.jobs.claim()
    assert.equal(await repos.jobs.claim(), null)
    await t.db.query(`UPDATE app.jobs SET locked_at = now() - make_interval(secs => $2::float8) WHERE id = $1`, [stuck, STALE_LOCK_SECONDS + 5])
    assert.equal(await repos.jobs.claim(['generate_report']), null, 'type filter')
    const recovered = await repos.jobs.claim(['evaluate_answer'])
    assert.equal(recovered?.id, stuck)
    assert.equal(recovered?.attempts, 2)
    await repos.jobs.complete(stuck)
    await t.db.query(`UPDATE app.jobs SET updated_at = now() - interval '8 days' WHERE id = $1`, [stuck])
    assert.equal(await repos.jobs.purgeFinished(7), 1)
  })
})

describe('evaluations and reports', () => {
  it('benchmark runs track progress and averages; summaries are per workspace', async () => {
    const testCase = await repos.evaluations.addCase({ workspaceId: bob.workspaceId, question: 'Q?', referenceAnswer: 'A.', collectionId: null, createdBy: bob.id })
    const run = await repos.evaluations.createRun(bob.workspaceId, bob.id, 1)
    assert.equal(run.status, 'queued')
    await repos.evaluations.save({
      workspaceId: bob.workspaceId,
      runId: run.id,
      caseId: testCase.id,
      question: 'Q?',
      answer: 'A.',
      scores: { faithfulness: 0.5, answerRelevance: 1, contextPrecision: 1, contextRecall: 0.25 },
      details: {},
      model: null,
    })
    await repos.evaluations.incrementRunProgress(run.id)
    await repos.evaluations.markRun(run.id, 'completed')
    const [stored] = await repos.evaluations.runs(bob.workspaceId)
    assert.equal(stored?.completedCount, 1)
    assert.equal(stored?.status, 'completed')
    assert.ok(stored?.finishedAt)
    assert.deepEqual(stored?.averages, { faithfulness: 0.5, answerRelevance: 1, contextPrecision: 1, contextRecall: 0.25 })
    assert.deepEqual([...(await repos.evaluations.scoredCaseIds(run.id))], [testCase.id])

    const summary = await repos.evaluations.summary(bob.workspaceId, { days: 30, ownerId: null })
    assert.equal(summary.evaluated, 0, 'benchmark answers are not live answers')
    assert.equal(summary.averages.contextRecall, 0.25)
    assert.equal(summary.lastBenchmark?.id, run.id)
    assert.equal((await repos.evaluations.summary(alice.workspaceId, { days: 30, ownerId: null })).lastBenchmark, null)
    assert.equal(await repos.evaluations.deleteCase(alice.workspaceId, testCase.id), false)
  })

  it('reports are scoped to their workspace', async () => {
    const report = await repos.reports.create({
      workspaceId: alice.workspaceId,
      createdBy: alice.id,
      template: 'executive_summary',
      format: 'markdown',
      title: 'Summary',
      instructions: null,
      collectionIds: [alice.notebookId],
      documentIds: [],
    })
    assert.equal(report.status, 'queued')
    assert.equal(report.createdByEmail, 'alice@example.com')
    assert.equal(await repos.reports.get(bob.workspaceId, report.id), null)
    assert.deepEqual((await repos.reports.forJob(report.id))?.collectionIds, [alice.notebookId])
    await repos.reports.complete(report.id, { content: '# Done', output: null, sources: [{ documentId: 'd', title: 't', source: 's' }] })
    const detail = await repos.reports.get(alice.workspaceId, report.id)
    assert.equal(detail?.status, 'completed')
    assert.equal(detail?.content, '# Done')
    assert.equal(detail?.sources.length, 1)
    assert.equal(await repos.reports.delete(bob.workspaceId, report.id), false)
    assert.equal(await repos.reports.delete(alice.workspaceId, report.id), true)
  })
})

describe('rate limits and one-time codes', () => {
  it('counts within a window and resets after it', async () => {
    const key = `test:${Date.now()}`
    assert.equal((await repos.rateLimits.hit(key, 60)).count, 1)
    assert.equal((await repos.rateLimits.hit(key, 60)).count, 2)
    await t.db.query(`UPDATE app.rate_limits SET window_start = now() - interval '2 minutes' WHERE key = $1`, [key])
    assert.equal((await repos.rateLimits.hit(key, 60)).count, 1)
  })

  it('OTP attempts are capped and a code can be consumed only once', async () => {
    await repos.otp.save('otp@example.com', 'hash-1', 600)
    for (let i = 0; i < 5; i++) assert.ok(await repos.otp.registerAttempt('otp@example.com', 5))
    assert.equal(await repos.otp.registerAttempt('otp@example.com', 5), null)

    await repos.otp.save('otp@example.com', 'hash-2', 600)
    assert.ok(await repos.otp.registerAttempt('otp@example.com', 5))
    const results = await Promise.all([repos.otp.consume('otp@example.com', 'hash-2'), repos.otp.consume('otp@example.com', 'hash-2')])
    assert.deepEqual(results.sort(), [false, true])
  })

  it('expired codes are rejected', async () => {
    await repos.otp.save('late@example.com', 'hash', 600)
    await t.db.query(`UPDATE app.otp_codes SET expires_at = now() - interval '1 second' WHERE email = $1`, ['late@example.com'])
    assert.equal(await repos.otp.registerAttempt('late@example.com', 5), null)
  })
})

describe('analytics', () => {
  it('summarises the caller’s own queries, or the whole workspace', async () => {
    const team = await createTeam(repos, alice, [[bob, 'viewer']])
    const base = { collectionId: null, latencyMs: 100, chunksRetrieved: 3 }
    await repos.analytics.log({ ...base, workspaceId: team.workspaceId, ownerId: alice.id, mode: 'standard', query: 'q', status: 'ok' })
    await repos.analytics.log({ ...base, workspaceId: team.workspaceId, ownerId: alice.id, mode: 'deep', query: 'q2', latencyMs: 300, status: 'error' })
    await repos.analytics.log({ ...base, workspaceId: team.workspaceId, ownerId: bob.id, mode: 'standard', query: 'bob asks', latencyMs: 50, status: 'insufficient_context' })
    await repos.analytics.log({ ...base, workspaceId: bob.workspaceId, ownerId: bob.id, mode: 'standard', query: 'bob private', status: 'ok' })

    const mine = await repos.analytics.summary({ workspaceId: team.workspaceId, ownerId: alice.id })
    assert.equal(mine.scope, 'me')
    assert.equal(mine.totals.queries, 2)
    assert.equal(mine.totals.errors, 1)
    assert.equal(mine.totals.avgLatencyMs, 100)
    assert.deepEqual(mine.byMode, { standard: 1, deep: 1 })

    const everyone = await repos.analytics.summary({ workspaceId: team.workspaceId, ownerId: null })
    assert.equal(everyone.scope, 'workspace')
    assert.equal(everyone.totals.queries, 3)
    assert.equal(everyone.totals.insufficient, 1)
    assert.ok(everyone.recent.every((entry) => entry.query !== 'bob private'))
  })
})
