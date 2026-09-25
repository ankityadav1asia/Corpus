import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { INSUFFICIENT_CONTEXT_MESSAGE } from '@/lib/constants'
import { DAILY_QUOTA_MESSAGE } from '@/server/ai/provider'
import { AppError } from '@/server/http/errors'
import { CHUNK_OVERLAP, CHUNK_SIZE, indexQueuedDocument, queueDocument } from '@/server/ingestion/ingest-service'
import { runJobs } from '@/server/jobs/runner'
import { createLlmReranker } from '@/server/rag/rerank'
import { splitText } from '@/server/rag/text-splitter'
import { createRepositories, type Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'

import { createTestDb, type TestDb } from './helpers/db'
import { TINY_PNG, createFakeAi, createFakeImages, fakeEmbedding, type FakeAi, type FakeImages } from './helpers/fake-ai'
import { addDocument, createTeam, createUser, type TestUser } from './helpers/fixtures'

let t: TestDb
let repos: Repositories
let owner: TestUser
let other: TestUser

before(async () => {
  t = await createTestDb()
  repos = createRepositories(t.db)
  owner = await createUser(repos, 'owner@example.com', 'Owner')
  other = await createUser(repos, 'other@example.com')
})

after(() => t.close())

const context = (ai: FakeAi = createFakeAi(), images: FakeImages = createFakeImages()) => ({
  repos,
  ai: () => ai,
  reranker: () => createLlmReranker(ai),
  images: () => images,
})

const source = (text: string, extra: Partial<Parameters<typeof queueDocument>[1]> = {}) => ({
  workspaceId: owner.workspaceId,
  createdBy: owner.id,
  collectionId: owner.notebookId,
  sourceType: 'file' as const,
  source: 'upload.txt',
  title: 'upload.txt',
  text,
  ...extra,
})

async function resetJobs() {
  await t.db.query('DELETE FROM app.jobs')
}

describe('background indexing', () => {
  it('queues a source as processing, indexes it in the background and notifies the author', async () => {
    await resetJobs()
    const text = 'Background indexing turns queued uploads into searchable passages.\n\n'.repeat(40)
    const document = await queueDocument(repos, source(text, { title: 'Queued upload', byteSize: 12_345 }))
    assert.equal(document.status, 'processing')
    assert.equal(document.chunkCount, 0)
    assert.equal(document.byteSize, 12_345)
    assert.ok((document.totalChunks ?? 0) > 1)
    const hidden = await repos.documents.keywordSearch({ workspaceId: owner.workspaceId, collectionId: null, query: 'queued uploads', limit: 5 })
    assert.equal(hidden.length, 0, 'not searchable while indexing')

    const ai = createFakeAi()
    assert.deepEqual(await runJobs(context(ai), { types: ['ingest_document'] }), { processed: 1, failed: 0 })
    const ready = await repos.documents.get(owner.workspaceId, document.id)
    assert.equal(ready?.status, 'ready')
    assert.equal(ready?.chunkCount, document.totalChunks)
    assert.equal((await repos.documents.keywordSearch({ workspaceId: owner.workspaceId, collectionId: null, query: 'queued uploads', limit: 5 }))[0]?.documentId, document.id)
    const [staged] = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.document_uploads WHERE document_id = $1', [document.id])
    assert.equal(staged?.n, 0, 'the staged text is dropped once indexed')

    const { items, unread } = await repos.notifications.list(owner.id)
    assert.equal(items[0]?.kind, 'document_ready')
    assert.deepEqual(items[0]?.link, { tab: 'sources', id: document.id })
    assert.equal(unread, 1)
  })

  it('a stopping worker finishes its current job and leaves the rest queued', async () => {
    await resetJobs()
    await queueDocument(repos, source('First queued source for the shutdown test.', { title: 'First', source: 'first.txt' }))
    await queueDocument(repos, source('Second queued source for the shutdown test.', { title: 'Second', source: 'second.txt' }))
    let claims = 0
    const result = await runJobs(context(), { types: ['ingest_document'], shouldStop: () => claims++ >= 1 })
    assert.deepEqual(result, { processed: 1, failed: 0 })
    const [row] = await t.db.query<{ queued: number }>(`SELECT count(*)::int AS queued FROM app.jobs WHERE status = 'queued'`)
    assert.equal(row?.queued, 1)
    assert.deepEqual(await runJobs(context(), { types: ['ingest_document'] }), { processed: 1, failed: 0 })
  })

  it('rejects bad input before storing or embedding anything', async () => {
    const is = (status: number) => (error: unknown) => error instanceof AppError && error.status === status
    await assert.rejects(queueDocument(repos, source('   ')), is(422))
    await assert.rejects(queueDocument(repos, source('text', { collectionId: other.notebookId })), is(404))
    await assert.rejects(queueDocument(repos, source('a'.repeat(1_000_001))), is(413))
  })

  it('resumes where an interrupted run stopped instead of re-embedding everything', async () => {
    await resetJobs()
    const paragraph = `${'Resumable indexing keeps what was already embedded. '.repeat(17)}\n\n`
    const document = await queueDocument(repos, source(paragraph.repeat(160), { title: 'Resumable' }))
    const total = document.totalChunks!
    assert.ok(total > 100, `needs more than one step (got ${total} chunks)`)

    const ai = createFakeAi()
    assert.equal(await indexQueuedDocument({ repos, ai }, document.id, Date.now() - 1), 'more', 'no time left: nothing done, ask to continue')
    assert.equal(ai.calls.embedDocuments.length, 0)

    // Simulate a run that stored the first 100 chunks and then died.
    const pending = await repos.documents.pendingIngest(document.id)
    const first = splitText(pending!.text, { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP }).slice(0, 100)
    await repos.documents.insertChunks(
      { id: document.id, workspaceId: owner.workspaceId, collectionId: owner.notebookId },
      first.map((content) => ({ content, embedding: fakeEmbedding(content) })),
    )

    assert.equal(await indexQueuedDocument({ repos, ai }, document.id, Date.now() + 60_000), 'done')
    const embedded = ai.calls.embedDocuments.flat().length
    assert.equal(embedded, total - 100, 'only the remaining passages were embedded')
    const indexes = await t.db.query<{ chunk_index: number }>('SELECT chunk_index FROM app.chunks WHERE document_id = $1 ORDER BY chunk_index', [document.id])
    assert.deepEqual(
      indexes.map((row) => Number(row.chunk_index)),
      Array.from({ length: total }, (_, i) => i),
    )
  })

  it('fails after the last attempt with a readable reason, keeps the text, and can be retried', async () => {
    await resetJobs()
    const document = await queueDocument(repos, source('Retry me later please, the embedding service is down.', { title: 'Flaky source' }))
    const broken = createFakeAi({ failEmbedding: true })
    for (let attempt = 0; attempt < JOB_ATTEMPTS.ingest_document; attempt++) {
      await t.db.query('UPDATE app.jobs SET run_after = now()')
      await runJobs(context(broken), { types: ['ingest_document'] })
    }
    const failed = await repos.documents.get(owner.workspaceId, document.id)
    assert.equal(failed?.status, 'failed')
    assert.match(failed!.error!, /temporarily unavailable/)
    assert.equal((await repos.notifications.list(owner.id)).items[0]?.kind, 'document_failed')

    assert.equal(await repos.documents.retryIngest(other.workspaceId, document.id), null, 'other workspaces cannot retry it')
    const retried = await repos.documents.retryIngest(owner.workspaceId, document.id)
    assert.equal(retried?.status, 'processing')
    assert.equal(retried?.error, null)
    await repos.jobs.enqueue('ingest_document', { documentId: document.id })
    await runJobs(context(), { types: ['ingest_document'] })
    assert.equal((await repos.documents.get(owner.workspaceId, document.id))?.status, 'ready')
    assert.equal(await repos.documents.retryIngest(owner.workspaceId, document.id), null, 'only failed documents can be retried')
  })

  it('keeps chunks of documents that are still indexing out of the explorer and the editor', async () => {
    const document = await queueDocument(repos, source('Half way there. '.repeat(10), { title: 'In progress' }))
    const page = await repos.chunks.list({ workspaceId: owner.workspaceId, documentId: document.id, page: 0, pageSize: 10 })
    assert.equal(page.total, 0)
    await repos.documents.insertChunks({ id: document.id, workspaceId: owner.workspaceId, collectionId: owner.notebookId }, [
      { content: 'partial', embedding: fakeEmbedding('partial') },
    ])
    const [chunk] = await t.db.query<{ id: string }>('SELECT id FROM app.chunks WHERE document_id = $1', [document.id])
    assert.equal(await repos.chunks.location(owner.workspaceId, chunk!.id), null)
  })

  it('reads a document back in order for the source viewer', async () => {
    const document = await addDocument(repos, {
      workspaceId: owner.workspaceId,
      collectionId: owner.notebookId,
      createdBy: owner.id,
      title: 'Viewer',
      chunks: ['one', 'two', 'three'],
    })
    const detail = await repos.documents.detail(owner.workspaceId, document.id, 10)
    assert.deepEqual(
      detail?.chunks.map((chunk) => [chunk.chunkIndex, chunk.content]),
      [
        [0, 'one'],
        [1, 'two'],
        [2, 'three'],
      ],
    )
    assert.equal(await repos.documents.detail(other.workspaceId, document.id, 10), null)
  })
})

describe('image generation', () => {
  let biologyId: string

  before(async () => {
    const biology = await addDocument(repos, {
      workspaceId: owner.workspaceId,
      collectionId: owner.notebookId,
      createdBy: owner.id,
      title: 'Photosynthesis basics',
      chunks: ['Photosynthesis converts light energy into chemical energy stored in glucose.', 'Chlorophyll absorbs mostly blue and red light.'],
    })
    biologyId = biology.id
  })

  async function queueImage(prompt: string, extra: { documentIds?: string[]; collectionId?: string | null } = {}) {
    const image = await repos.images.create({
      workspaceId: owner.workspaceId,
      createdBy: owner.id,
      collectionId: extra.collectionId === undefined ? owner.notebookId : extra.collectionId,
      documentIds: extra.documentIds ?? [],
      prompt,
      style: 'infographic',
      aspectRatio: '16:9',
    })
    await repos.jobs.enqueue('generate_image', { imageId: image.id }, { maxAttempts: JOB_ATTEMPTS.generate_image })
    return image.id
  }

  it('grounds the brief in retrieved passages, stores a verified image and notifies the author', async () => {
    await resetJobs()
    const id = await queueImage('Show how photosynthesis converts light energy into chemical energy')
    const images = createFakeImages()
    assert.deepEqual(await runJobs(context(createFakeAi(), images), { types: ['generate_image'] }), { processed: 1, failed: 0 })

    const detail = await repos.images.get(owner.workspaceId, id)
    assert.equal(detail?.status, 'completed')
    assert.equal(detail?.mimeType, 'image/png')
    assert.deepEqual([detail?.width, detail?.height, detail?.byteSize], [1, 1, TINY_PNG.length])
    assert.equal(detail?.title, 'Grounded picture')
    assert.equal(detail?.model, 'fake-image-model')
    assert.ok(detail!.sources.some((item) => item.title === 'Photosynthesis basics'))
    assert.match(detail!.finalPrompt!, /Photosynthesis converts light energy/, 'the brief quotes the knowledge base')
    assert.match(detail!.finalPrompt!, /Aspect ratio 16:9/)
    assert.equal(images.calls[0]?.aspectRatio, '16:9')

    const file = await repos.images.file(id)
    assert.deepEqual(Buffer.from(file!.data), TINY_PNG, 'bytes survive the round trip')
    assert.equal(file?.workspaceId, owner.workspaceId)
    assert.equal((await repos.notifications.list(owner.id)).items[0]?.kind, 'image_ready')
    assert.equal(await repos.images.get(other.workspaceId, id), null)
  })

  it('draws from chosen documents without a relevance search', async () => {
    await resetJobs()
    const id = await queueImage('A poster about football', { documentIds: [biologyId], collectionId: null })
    const ai = createFakeAi()
    await runJobs(context(ai), { types: ['generate_image'] })
    assert.equal((await repos.images.get(owner.workspaceId, id))?.status, 'completed')
    assert.deepEqual(ai.calls.embedQuery, [], 'no search when the documents are chosen')
  })

  it('refuses to invent: with nothing relevant the request fails with the guardrail message', async () => {
    await resetJobs()
    const id = await queueImage('Standings of the football league')
    const images = createFakeImages()
    await runJobs(context(createFakeAi(), images), { types: ['generate_image'] })
    const detail = await repos.images.get(owner.workspaceId, id)
    assert.equal(detail?.status, 'failed')
    assert.ok(detail!.error!.startsWith(INSUFFICIENT_CONTEXT_MESSAGE))
    assert.equal(images.calls.length, 0, 'the image model is never called')
  })

  it('safety refusals fail at once; rate limits wait as long as asked; non-images are rejected', async () => {
    await resetJobs()
    const refused = await queueImage('Show how photosynthesis converts light energy', {})
    await runJobs(context(createFakeAi(), createFakeImages({ behaviour: 'refuse' })), { types: ['generate_image'] })
    const refusedDetail = await repos.images.get(owner.workspaceId, refused)
    assert.equal(refusedDetail?.status, 'failed')
    assert.match(refusedDetail!.error!, /safety filters/)

    await resetJobs()
    const limited = await queueImage('Show how photosynthesis converts light energy')
    await runJobs(context(createFakeAi(), createFakeImages({ behaviour: 'rate-limit' })), { types: ['generate_image'] })
    const [job] = await t.db.query<{ wait: number; status: string }>(`SELECT status, extract(epoch FROM run_after - now())::int AS wait FROM app.jobs`)
    assert.equal(job?.status, 'queued')
    assert.ok(job!.wait >= 85, `retry scheduled after the requested 90s, got ${job!.wait}s`)
    const waiting = await repos.images.get(owner.workspaceId, limited)
    assert.equal(waiting?.status, 'queued')
    assert.equal(waiting?.progress, 'AI service busy — retrying in ~91 s', 'the card says why it is waiting')

    await resetJobs()
    const exhausted = await queueImage('Show how photosynthesis converts light energy')
    const before = (await repos.notifications.list(owner.id)).items.length
    assert.deepEqual(await runJobs(context(createFakeAi(), createFakeImages({ behaviour: 'daily-quota' })), { types: ['generate_image'] }), { processed: 0, failed: 1 })
    const [spent] = await t.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM app.jobs`)
    assert.deepEqual([spent?.status, spent?.attempts], ['failed', 1], 'no retries against a used-up daily quota')
    const exhaustedDetail = await repos.images.get(owner.workspaceId, exhausted)
    assert.equal(exhaustedDetail?.status, 'failed')
    assert.equal(exhaustedDetail?.error, DAILY_QUOTA_MESSAGE)
    const notifications = (await repos.notifications.list(owner.id)).items
    assert.equal(notifications.length, before + 1)
    assert.equal(notifications[0]?.kind, 'image_failed')

    await resetJobs()
    const garbage = await queueImage('Show how photosynthesis converts light energy')
    const broken = createFakeImages({ behaviour: 'garbage' })
    for (let attempt = 0; attempt < JOB_ATTEMPTS.generate_image; attempt++) {
      await t.db.query('UPDATE app.jobs SET run_after = now()')
      await runJobs(context(createFakeAi(), broken), { types: ['generate_image'] })
    }
    const rejected = await repos.images.get(owner.workspaceId, garbage)
    assert.equal(rejected?.status, 'failed')
    assert.equal(await repos.images.file(garbage), null)
  })
})

describe('feedback, notifications, audit and pins', () => {
  it('stores one rating per person per answer and summarises it', async () => {
    const conversation = await repos.conversations.create({ workspaceId: owner.workspaceId, ownerId: owner.id, collectionId: null, title: 'Rated' })
    await repos.conversations.addMessage({ conversationId: conversation.id, role: 'user', content: 'What is RRF?' })
    const answer = await repos.conversations.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'A fusion method.' })
    await repos.feedback.set({ messageId: answer.id, userId: owner.id, workspaceId: owner.workspaceId, rating: 1, comment: null })
    await repos.feedback.set({ messageId: answer.id, userId: owner.id, workspaceId: owner.workspaceId, rating: -1, comment: 'Too short' })
    const [, stored] = await repos.conversations.messages(conversation.id, owner.id)
    assert.deepEqual(stored?.feedback, { rating: -1, comment: 'Too short' })
    assert.equal((await repos.conversations.messages(conversation.id, other.id))[1]?.feedback, null, 'only your own rating is shown')

    const summary = await repos.feedback.summary(owner.workspaceId, { days: 7, userId: null })
    assert.deepEqual([summary.positive, summary.negative], [0, 1])
    assert.deepEqual(summary.recent[0] && { question: summary.recent[0].question, comment: summary.recent[0].comment }, { question: 'What is RRF?', comment: 'Too short' })
    await repos.feedback.remove(answer.id, owner.id)
    assert.equal((await repos.feedback.summary(owner.workspaceId, { days: 7, userId: null })).negative, 0)
    assert.deepEqual(await repos.conversations.messageContext(answer.id), { workspaceId: owner.workspaceId, ownerId: owner.id, role: 'assistant' })
  })

  it('hides notifications from workspaces the person has left and marks them read', async () => {
    const team = await createTeam(repos, owner, [[other, 'viewer']])
    await repos.notifications.create({ userId: other.id, workspaceId: team.workspaceId, kind: 'member_added', title: 'Welcome', link: { tab: 'chat' } })
    await repos.notifications.create({ userId: other.id, workspaceId: null, kind: 'report_ready', title: 'Global' })
    assert.equal((await repos.notifications.list(other.id)).unread, 2)
    const ownerUnread = (await repos.notifications.list(owner.id)).unread
    assert.equal(await repos.notifications.markRead(owner.id, 'all'), ownerUnread)
    assert.equal((await repos.notifications.list(other.id)).unread, 2, 'marking only touches your own notifications')

    await repos.workspaces.removeMember(team.workspaceId, other.id)
    const after = await repos.notifications.list(other.id)
    assert.deepEqual(
      after.items.map((item) => item.title),
      ['Global'],
    )
    const [global] = after.items
    assert.equal(await repos.notifications.markRead(other.id, [global!.id]), 1)
    assert.equal((await repos.notifications.list(other.id)).unread, 0)
  })

  it('records audit events with the actor, newest first', async () => {
    await repos.audit.record({ workspaceId: owner.workspaceId, actorId: owner.id, action: 'notebook.created', targetType: 'notebook', targetId: 'n1', details: { name: 'A' } })
    await repos.audit.record({ workspaceId: owner.workspaceId, actorId: owner.id, action: 'notebook.renamed', details: { from: 'A', to: 'B' } })
    const events = await repos.audit.list(owner.workspaceId)
    assert.deepEqual(
      events.slice(0, 2).map((event) => [event.action, event.actorEmail]),
      [
        ['notebook.renamed', 'owner@example.com'],
        ['notebook.created', 'owner@example.com'],
      ],
    )
    assert.deepEqual(events[0]?.details, { from: 'A', to: 'B' })
    assert.deepEqual(await repos.audit.list(other.workspaceId), [])
  })

  it('lists pinned conversations first and only the author can pin', async () => {
    const older = await repos.conversations.create({ workspaceId: owner.workspaceId, ownerId: owner.id, collectionId: null, title: 'Older' })
    await repos.conversations.create({ workspaceId: owner.workspaceId, ownerId: owner.id, collectionId: null, title: 'Newer' })
    assert.equal(await repos.conversations.setPinned(owner.workspaceId, other.id, older.id, true), null)
    const pinned = await repos.conversations.setPinned(owner.workspaceId, owner.id, older.id, true)
    assert.equal(pinned?.pinned, true)
    const list = await repos.conversations.list(owner.workspaceId, owner.id)
    assert.equal(list[0]?.title, 'Older')
    await repos.conversations.setPinned(owner.workspaceId, owner.id, older.id, false)
    assert.equal((await repos.conversations.list(owner.workspaceId, owner.id))[0]?.pinned, false)
  })
})
