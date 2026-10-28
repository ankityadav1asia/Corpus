import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { INSUFFICIENT_CONTEXT_MESSAGE } from '@/lib/constants'
import type { WorkspaceSettingsPatch } from '@/lib/contracts'
import { AiProviderError } from '@/server/ai/provider'
import { appendChunk, deleteChunk, updateChunk } from '@/server/corpus/chunk-editor'
import { runBenchmarkBatch } from '@/server/evaluation/service'
import { AppError } from '@/server/http/errors'
import { ingestDocument } from '@/server/ingestion/ingest-service'
import { runJobs } from '@/server/jobs/runner'
import { createLlmReranker } from '@/server/rag/rerank'
import { toCitations } from '@/server/rag/retrieval'
import { createRepositories, type Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { mergeSettings } from '@/server/repositories/workspaces'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, createFakeImages, isJudge, type FakeAi, type FakeImages } from './helpers/fake-ai'
import { accessFor, addDocument, createTeam, createUser, type TestUser } from './helpers/fixtures'

let t: TestDb
let repos: Repositories
let owner: TestUser
let stranger: TestUser

before(async () => {
  t = await createTestDb()
  repos = createRepositories(t.db)
  owner = await createUser(repos, 'owner@example.com', 'Owner')
  stranger = await createUser(repos, 'stranger@example.com')
  // The fake embedding / grader are cruder than the real models, so the thresholds are lowered
  // for these tests; the guardrail itself is exercised explicitly below.
  await setSettings(owner.workspaceId, { guardrail: { minRelevance: 0.2, minSimilarity: 0.1 } })
})

after(() => t.close())

async function setSettings(workspaceId: string, patch: WorkspaceSettingsPatch) {
  await repos.workspaces.saveSettings(workspaceId, mergeSettings(await repos.workspaces.settings(workspaceId), patch))
}

/**
 * An answered question as the chat route (now the Go API, backend/api/chat.go) stores it, with its
 * evaluation queued. Asking itself is tested in backend/api/chat_test.go.
 */
async function answered(question: string) {
  const conversation = await repos.conversations.create({ workspaceId: owner.workspaceId, ownerId: owner.id, collectionId: owner.notebookId, title: question })
  await repos.conversations.addMessage({ conversationId: conversation.id, role: 'user', content: question })
  const hits = await repos.documents.keywordSearch({ workspaceId: owner.workspaceId, collectionId: owner.notebookId, query: 'photosynthesis', limit: 3 })
  const answer = await repos.conversations.addMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: 'Photosynthesis converts light energy into chemical energy [1].',
    citations: toCitations(hits.map((hit) => ({ ...hit, relevance: null }))),
  })
  await repos.jobs.enqueue('evaluate_answer', { messageId: answer.id, chunkIds: hits.map((hit) => hit.chunkId) }, { maxAttempts: JOB_ATTEMPTS.evaluate_answer })
  return conversation.id
}

const jobContext = (ai: FakeAi, images: FakeImages = createFakeImages()) => ({ repos, ai: () => ai, reranker: () => createLlmReranker(ai), images: () => images })

describe('ingestion service', () => {
  it('chunks, embeds and stores a document, then makes it searchable', async () => {
    const ai = createFakeAi()
    const text = 'Photosynthesis converts light energy into chemical energy.\n\n'.repeat(40)
    const result = await ingestDocument(
      { repos, ai },
      { workspaceId: owner.workspaceId, createdBy: owner.id, collectionId: owner.notebookId, sourceType: 'text', source: 'pasted-text', title: 'Biology', text },
    )
    assert.equal(result.document.status, 'ready')
    assert.ok(result.document.chunkCount > 1)
    assert.equal(ai.calls.embedDocuments.length, 1)
    const hits = await repos.documents.keywordSearch({ workspaceId: owner.workspaceId, collectionId: owner.notebookId, query: 'photosynthesis', limit: 3 })
    assert.equal(hits[0]?.title, 'Biology')
  })

  it('strips NUL bytes that Postgres cannot store', async () => {
    const result = await ingestDocument(
      { repos, ai: createFakeAi() },
      {
        workspaceId: owner.workspaceId,
        createdBy: owner.id,
        collectionId: owner.notebookId,
        sourceType: 'file',
        source: 'nul.txt',
        title: 'nul.txt',
        text: 'pdf\u0000text with nul',
      },
    )
    const page = await repos.chunks.list({ workspaceId: owner.workspaceId, documentId: result.document.id, page: 0, pageSize: 5 })
    assert.equal(page.items[0]?.content, 'pdftext with nul')
  })

  it('removes the half-created document when embedding fails', async () => {
    const before = (await repos.documents.list(owner.workspaceId, owner.notebookId)).length
    await assert.rejects(
      ingestDocument(
        { repos, ai: createFakeAi({ failEmbedding: true }) },
        { workspaceId: owner.workspaceId, createdBy: owner.id, collectionId: owner.notebookId, sourceType: 'text', source: 'x', title: 'x', text: 'some text' },
      ),
      (error: unknown) => error instanceof AppError && error.status === 502,
    )
    assert.equal((await repos.documents.list(owner.workspaceId, owner.notebookId)).length, before)
  })

  it('rejects notebooks of another workspace, empty text and oversized documents', async () => {
    const ai = createFakeAi()
    const base = { workspaceId: owner.workspaceId, createdBy: owner.id, sourceType: 'text' as const, source: 's', title: 't' }
    const is = (status: number) => (e: unknown) => e instanceof AppError && e.status === status
    await assert.rejects(ingestDocument({ repos, ai }, { ...base, collectionId: stranger.notebookId, text: 'hello' }), is(404))
    await assert.rejects(ingestDocument({ repos, ai }, { ...base, collectionId: owner.notebookId, text: ' \n\t ' }), is(422))
    await assert.rejects(ingestDocument({ repos, ai }, { ...base, collectionId: owner.notebookId, text: 'a'.repeat(1_000_001) }), is(413))
    assert.equal(ai.calls.embedDocuments.length, 0, 'nothing is embedded (no AI spend) for rejected input')
  })
})

describe('background evaluation', () => {
  // Which answers are sampled for evaluation is decided by the Go chat route (backend/api/chat.go).
  it('scores queued answers with the judge (faithfulness, relevance, precision)', async () => {
    await t.db.query('DELETE FROM app.jobs')
    const conversationId = await answered('What does photosynthesis convert?')

    const judge = createFakeAi()
    assert.deepEqual(await runJobs(jobContext(judge)), { processed: 1, failed: 0 })
    assert.equal(judge.calls.complete.filter(isJudge).length, 1)
    const [, answer] = await repos.conversations.messages(conversationId)
    assert.deepEqual(answer?.evaluation, { faithfulness: 1, answerRelevance: 1, contextPrecision: 1, contextRecall: null })

    const summary = await repos.evaluations.summary(owner.workspaceId, { days: 7, ownerId: null })
    assert.equal(summary.evaluated, 1)
    assert.equal(summary.averages.faithfulness, 1)
  })

  it('flags unfaithful answers for review and retries judge failures', async () => {
    await t.db.query('DELETE FROM app.jobs')
    await answered('What does photosynthesis convert?')
    const flaky = createFakeAi({ failComplete: isJudge })
    assert.deepEqual(await runJobs(jobContext(flaky)), { processed: 0, failed: 1 })
    const [job] = await t.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM app.jobs WHERE type = 'evaluate_answer'`)
    assert.deepEqual(job, { status: 'queued', attempts: 1 })

    await t.db.query(`UPDATE app.jobs SET run_after = now()`)
    const harsh = createFakeAi({
      complete: (input) =>
        isJudge(input)
          ? JSON.stringify({ claims: [{ supported: false }, { supported: true }, { supported: false }, { supported: false }], answer_relevance: 2, passages: [] })
          : undefined,
    })
    assert.deepEqual(await runJobs(jobContext(harsh)), { processed: 1, failed: 0 })
    const summary = await repos.evaluations.summary(owner.workspaceId, { days: 7, ownerId: owner.id })
    const flagged = summary.flagged[0]
    assert.equal(flagged?.scores.faithfulness, 0.25)
    assert.equal(flagged?.scores.answerRelevance, 0.25)
    assert.equal(flagged?.question, 'What does photosynthesis convert?')
  })

  it('benchmark runs go through the live pipeline and measure context recall against references', async () => {
    await t.db.query('DELETE FROM app.jobs')
    const relevant = await repos.evaluations.addCase({
      workspaceId: owner.workspaceId,
      question: 'What does photosynthesis convert?',
      referenceAnswer: 'Light energy into chemical energy.',
      collectionId: owner.notebookId,
      createdBy: owner.id,
    })
    await repos.evaluations.addCase({
      workspaceId: owner.workspaceId,
      question: 'Who won the football league yesterday?',
      referenceAnswer: 'Nobody knows.',
      collectionId: null,
      createdBy: owner.id,
    })
    const run = await repos.evaluations.createRun(owner.workspaceId, owner.id, 2)
    await repos.jobs.enqueue('run_benchmark', { runId: run.id })
    const ai = createFakeAi()
    assert.deepEqual(await runJobs(jobContext(ai)), { processed: 1, failed: 0 })

    const [stored] = await repos.evaluations.runs(owner.workspaceId, 1)
    assert.equal(stored?.status, 'completed')
    assert.equal(stored?.completedCount, 2)
    assert.equal(stored?.averages.contextRecall, 1)
    const answers = await t.db.query<{ case_id: string; answer: string }>(`SELECT case_id, answer FROM app.evaluations WHERE run_id = $1`, [run.id])
    assert.equal(answers.length, 2)
    assert.equal(answers.find((row) => row.case_id !== relevant.id)?.answer, INSUFFICIENT_CONTEXT_MESSAGE, 'the guardrail applies to benchmarks too')
    assert.equal(ai.calls.chat.length, 1)
  })

  it('a benchmark batch stops at its deadline and later resumes without rescoring', async () => {
    const ai = createFakeAi()
    const deps = { repos, ai, reranker: createLlmReranker(ai) }
    const run = await repos.evaluations.createRun(owner.workspaceId, owner.id, 2)
    assert.equal(await runBenchmarkBatch(deps, { runId: run.id }, Date.now() - 1), 'more')
    assert.equal((await repos.evaluations.runs(owner.workspaceId, 1))[0]?.status, 'running')

    // An earlier batch already scored the first case.
    const [first] = await repos.evaluations.cases(owner.workspaceId)
    const scores = { faithfulness: 1, answerRelevance: 1, contextPrecision: 1, contextRecall: 1 }
    await repos.evaluations.save({
      workspaceId: owner.workspaceId,
      runId: run.id,
      caseId: first!.id,
      question: first!.question,
      answer: 'earlier',
      scores,
      details: {},
      model: null,
    })
    assert.equal(await runBenchmarkBatch(deps, { runId: run.id }, Date.now() + 60_000), 'done')
    const rows = await t.db.query<{ case_id: string; answer: string }>(`SELECT case_id, answer FROM app.evaluations WHERE run_id = $1`, [run.id])
    assert.equal(rows.length, 2, 'each case scored exactly once')
    assert.equal(rows.find((row) => row.case_id === first!.id)?.answer, 'earlier')
    assert.equal((await repos.evaluations.runs(owner.workspaceId, 1))[0]?.status, 'completed')
    assert.equal(await runBenchmarkBatch(deps, { runId: '00000000-0000-4000-8000-000000000000' }, Date.now() + 1000), 'missing')
  })
})

describe('synthesis reports', () => {
  async function queueReport(template: 'executive_summary' | 'comparison_table' | 'slide_outline', format: 'markdown' | 'json' = 'markdown') {
    const report = await repos.reports.create({
      workspaceId: owner.workspaceId,
      createdBy: owner.id,
      template,
      format,
      title: `${template} report`,
      instructions: 'Focus on energy.',
      collectionIds: [owner.notebookId],
      documentIds: [],
    })
    await repos.jobs.enqueue('generate_report', { reportId: report.id }, { maxAttempts: 2 })
    return report.id
  }

  it('map-reduces every template over the selected documents', async () => {
    await t.db.query('DELETE FROM app.jobs')
    const ids = [await queueReport('executive_summary'), await queueReport('comparison_table'), await queueReport('slide_outline', 'markdown')]
    const ai = createFakeAi()
    assert.deepEqual(await runJobs(jobContext(ai), { maxJobs: 5 }), { processed: 3, failed: 0 })
    for (const id of ids) {
      const report = await repos.reports.get(owner.workspaceId, id)
      assert.equal(report?.status, 'completed')
      assert.ok(report?.content)
      assert.ok(report!.sources.length >= 2)
      assert.equal(report?.output, null)
    }
    const reduceCalls = ai.calls.complete.filter((call) => call.prompt.includes('<document id="1"'))
    assert.equal(reduceCalls.length, 3)
    assert.ok(reduceCalls.every((call) => call.prompt.includes('Focus on energy.')))
  })

  it('waits as long as the model vendor asks before retrying a rate-limited job', async () => {
    await t.db.query('DELETE FROM app.jobs')
    const id = await queueReport('executive_summary')
    const limited = createFakeAi({
      complete: () => {
        throw new AiProviderError('Gemini request failed (429)', 429, true, 90)
      },
    })
    assert.deepEqual(await runJobs(jobContext(limited)), { processed: 0, failed: 1 })
    const [job] = await t.db.query<{ wait: number }>(`SELECT extract(epoch FROM run_after - now())::int AS wait FROM app.jobs WHERE payload->>'reportId' = $1`, [id])
    assert.ok(job!.wait >= 85 && job!.wait <= 92, `retry scheduled after the requested 90s, got ${job!.wait}s`)
  })

  it('slide outlines as JSON are schema-validated and rendered; invalid output fails after retries', async () => {
    await t.db.query('DELETE FROM app.jobs')
    const good = await queueReport('slide_outline', 'json')
    await runJobs(jobContext(createFakeAi()))
    const report = await repos.reports.get(owner.workspaceId, good)
    assert.equal(report?.status, 'completed')
    assert.deepEqual(report?.output?.slides[0], { title: 'Overview', bullets: ['First point [1]', 'Second point'], notes: 'Say hello' })
    assert.match(report!.content!, /^# Deck[\s\S]*## Slide 1: Overview/)

    const bad = await queueReport('slide_outline', 'json')
    const broken = createFakeAi({ complete: (input) => (input.json ? '{"title": "", "slides": "nope"}' : undefined) })
    await runJobs(jobContext(broken))
    await t.db.query(`UPDATE app.jobs SET run_after = now()`)
    await runJobs(jobContext(broken))
    const failed = await repos.reports.get(owner.workspaceId, bad)
    assert.equal(failed?.status, 'failed')
    assert.match(failed!.error!, /^Something went wrong while processing this in the background/, 'internal parser errors are not shown to users')
  })
})

describe('chunk editor', () => {
  let documentId: string
  let chunkId: string
  let team: { workspaceId: string; notebookId: string }
  let viewer: TestUser
  let editor: TestUser

  before(async () => {
    viewer = await createUser(repos, 'viewer@example.com')
    editor = await createUser(repos, 'editor@example.com')
    team = await createTeam(repos, owner, [
      [viewer, 'viewer'],
      [editor, 'editor'],
    ])
    const document = await addDocument(repos, {
      workspaceId: team.workspaceId,
      collectionId: team.notebookId,
      createdBy: owner.id,
      title: 'Team doc',
      chunks: ['alpha text', 'beta text'],
    })
    documentId = document.id
    chunkId = (await repos.chunks.list({ workspaceId: team.workspaceId, documentId, page: 0, pageSize: 5 })).items[0]!.id
  })

  const is = (status: number) => (e: unknown) => e instanceof AppError && e.status === status

  it('re-embeds edited text, but not label or metadata changes', async () => {
    const ai = createFakeAi()
    const deps = { repos, ai: () => ai }
    const updated = await updateChunk(deps, accessFor(editor.id, team.workspaceId, 'editor'), chunkId, { content: '  gamma\u0000 text  ' })
    assert.equal(updated.content, 'gamma text')
    assert.deepEqual(ai.calls.embedDocuments, [['gamma text']])
    await updateChunk(deps, accessFor(editor.id, team.workspaceId, 'editor'), chunkId, { labels: ['reviewed'], metadata: { owner: 'ops' } })
    assert.equal(ai.calls.embedDocuments.length, 1)
    const hits = await repos.documents.vectorSearch({ workspaceId: team.workspaceId, collectionId: team.notebookId, embedding: await ai.embedQuery('gamma text'), limit: 1 })
    assert.equal(hits[0]?.chunkId, chunkId)
  })

  it('viewers cannot edit; notebook overrides can grant or restrict editing; admins always can', async () => {
    const deps = { repos, ai: () => createFakeAi() }
    const asViewer = accessFor(viewer.id, team.workspaceId, 'viewer')
    await assert.rejects(updateChunk(deps, asViewer, chunkId, { labels: ['x'] }), is(403))
    await assert.rejects(deleteChunk(deps, asViewer, chunkId), is(403))
    await assert.rejects(appendChunk(deps, asViewer, documentId, { content: 'new' }), is(403))

    await repos.collections.setRoleOverride(team.notebookId, viewer.id, 'editor')
    await updateChunk(deps, asViewer, chunkId, { labels: ['promoted'] })
    await repos.collections.setRoleOverride(team.notebookId, editor.id, 'viewer')
    await assert.rejects(updateChunk(deps, accessFor(editor.id, team.workspaceId, 'editor'), chunkId, { labels: ['x'] }), is(403))
    await repos.collections.setRoleOverride(team.notebookId, owner.id, 'viewer')
    await updateChunk(deps, accessFor(owner.id, team.workspaceId, 'admin'), chunkId, { labels: ['admin-wins'] })
  })

  it('appends and deletes chunks; ids from other workspaces are not found', async () => {
    const ai = createFakeAi()
    const deps = { repos, ai: () => ai }
    const asAdmin = accessFor(owner.id, team.workspaceId, 'admin')
    const added = await appendChunk(deps, asAdmin, documentId, { content: 'delta text', labels: ['manual'] })
    assert.equal(added.chunkIndex, 2)
    assert.deepEqual(added.labels, ['manual'])
    await deleteChunk(deps, asAdmin, added.id)
    await assert.rejects(updateChunk(deps, accessFor(stranger.id, stranger.workspaceId, 'admin'), chunkId, { labels: ['x'] }), is(404))
    await assert.rejects(updateChunk(deps, asAdmin, chunkId, { content: '\u0000 ' }), is(422))
    await assert.rejects(updateChunk({ repos, ai: () => createFakeAi({ failEmbedding: true }) }, asAdmin, chunkId, { content: 'new words' }), is(502))
    assert.notEqual((await repos.chunks.get(team.workspaceId, chunkId))?.content, 'new words', 'a failed re-embed leaves the chunk unchanged')
  })
})
