import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { INSUFFICIENT_CONTEXT_MESSAGE } from '@/lib/constants'
import type { WorkspaceSettingsPatch } from '@/lib/contracts'
import type { ChatStreamEvent } from '@/lib/stream-protocol'
import { AiProviderError } from '@/server/ai/provider'
import { appendChunk, deleteChunk, updateChunk } from '@/server/corpus/chunk-editor'
import { runBenchmarkBatch } from '@/server/evaluation/service'
import { AppError } from '@/server/http/errors'
import { ingestDocument } from '@/server/ingestion/ingest-service'
import { runJobs } from '@/server/jobs/runner'
import { prepareChat, runChat, type ChatDeps } from '@/server/rag/chat-service'
import { createLlmReranker, type Reranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { mergeSettings } from '@/server/repositories/workspaces'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, createFakeImages, isJudge, isRerank, type FakeAi, type FakeAiOptions, type FakeImages } from './helpers/fake-ai'
import { accessFor, addDocument, createTeam, createUser, type TestUser } from './helpers/fixtures'

let t: TestDb
let repos: Repositories
let owner: TestUser
let stranger: TestUser

type EventOf<T extends ChatStreamEvent['type']> = Extract<ChatStreamEvent, { type: T }>

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

async function collect(events: AsyncGenerator<ChatStreamEvent>) {
  const out: ChatStreamEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

interface AskOptions {
  ai?: FakeAiOptions
  conversationId?: string
  mode?: 'standard' | 'deep'
  reranker?: 'llm' | 'none'
  collectionId?: string | null
  random?: () => number
}

async function ask(message: string, options: AskOptions = {}) {
  const ai = createFakeAi(options.ai)
  const reranker: Reranker | null = options.reranker === 'none' ? null : createLlmReranker(ai)
  const deps: ChatDeps = { repos, ai, reranker, random: options.random ?? (() => 0) }
  const prepared = await prepareChat(deps, {
    workspaceId: owner.workspaceId,
    userId: owner.id,
    message,
    conversationId: options.conversationId,
    collectionId: options.collectionId === undefined ? owner.notebookId : options.collectionId,
    mode: options.mode ?? 'standard',
  })
  const events = await collect(runChat(deps, prepared))
  return { ai, prepared, events, types: events.map((e) => e.type), sources: events.find((e) => e.type === 'sources') as EventOf<'sources'> | undefined }
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

describe('chat service', () => {
  it('streams progress, re-ranked sources and the answer, and persists both turns', async () => {
    const { events, types, prepared, sources } = await ask('What does photosynthesis convert?')
    assert.deepEqual(types, ['start', 'status', 'status', 'sources', 'status', 'delta', 'delta', 'delta', 'done'])
    assert.deepEqual(
      events.filter((e): e is EventOf<'status'> => e.type === 'status').map((e) => e.stage),
      ['searching', 'reranking', 'generating'],
    )
    const start = events[0] as EventOf<'start'>
    assert.equal(start.createdConversation, true)
    assert.equal(start.conversationTitle, 'What does photosynthesis convert?')
    assert.ok(sources && sources.citations.length > 0 && sources.citations.length <= 5, 'top-K after re-ranking')
    assert.equal(sources.citations[0]!.index, 1)
    assert.ok(sources.citations[0]!.relevance! > 0)
    assert.deepEqual(
      sources.steps.map((step) => step.label),
      ['Retrieved', 'Re-ranked', 'Relevance check'],
    )

    const stored = await repos.conversations.messages(prepared.conversationId)
    assert.deepEqual(
      stored.map((m) => m.role),
      ['user', 'assistant'],
    )
    assert.equal(stored[1]!.content, 'Answer from sources [1].')
    assert.equal(stored[1]!.citations.length, sources.citations.length)
  })

  it('re-ranking decides which passages reach the model', async () => {
    await addDocument(repos, {
      workspaceId: owner.workspaceId,
      collectionId: owner.notebookId,
      createdBy: owner.id,
      title: 'Glossary',
      chunks: ['Chlorophyll pigment absorbs sunlight', 'Mitochondria produce cellular energy through respiration'],
    })
    const { sources, ai } = await ask('Which pigment absorbs sunlight?')
    assert.equal(sources?.citations[0]?.excerpt, 'Chlorophyll pigment absorbs sunlight')
    const rerankCall = ai.calls.complete.find(isRerank)
    assert.ok(rerankCall, 'the re-ranker was consulted')
    assert.match(ai.calls.chat[0]!.turns.at(-1)!.content, /Chlorophyll pigment absorbs sunlight/)
  })

  it('short-circuits with the exact guardrail message and never calls the model when nothing is relevant', async () => {
    const { types, events, ai, prepared, sources } = await ask('Who won the football league yesterday?')
    assert.deepEqual(types, ['start', 'status', 'status', 'sources', 'delta', 'done'])
    assert.equal((events.find((e) => e.type === 'delta') as EventOf<'delta'>).text, INSUFFICIENT_CONTEXT_MESSAGE)
    assert.equal(INSUFFICIENT_CONTEXT_MESSAGE, 'Insufficient context in knowledge base.')
    assert.equal(ai.calls.chat.length, 0, 'no answer generation')
    assert.deepEqual(sources?.citations, [], 'irrelevant passages are not shown as sources')
    assert.match(sources!.steps.at(-1)!.detail, /answer withheld/)
    const stored = await repos.conversations.messages(prepared.conversationId)
    assert.equal(stored.at(-1)?.content, INSUFFICIENT_CONTEXT_MESSAGE)
    const [log] = await t.db.query<{ status: string }>(`SELECT status FROM app.query_logs WHERE query = $1`, ['Who won the football league yesterday?'])
    assert.equal(log?.status, 'insufficient_context')
    const [jobs] = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.jobs WHERE payload->>'messageId' = $1`, [stored.at(-1)!.id])
    assert.equal(jobs?.n, 0, 'withheld answers are not evaluated')
  })

  it('falls back to cosine similarity when the re-ranker fails, and the guardrail can be disabled per workspace', async () => {
    const failing = await ask('What does photosynthesis convert?', { ai: { failComplete: isRerank } })
    assert.equal(failing.ai.calls.chat.length, 1, 'still answers from fusion order')
    assert.match(failing.sources!.steps.find((s) => s.label === 'Re-ranked')!.detail, /unavailable/)
    assert.match(failing.sources!.steps.at(-1)!.detail, /similarity/)

    const blocked = await ask('Who won the football league yesterday?', { reranker: 'none' })
    assert.equal(blocked.ai.calls.chat.length, 0)
    await setSettings(owner.workspaceId, { guardrail: { enabled: false } })
    try {
      const open = await ask('Who won the football league yesterday?', { reranker: 'none' })
      assert.equal(open.ai.calls.chat.length, 1)
      assert.match(open.sources!.steps.at(-1)!.detail, /turned off/)
    } finally {
      await setSettings(owner.workspaceId, { guardrail: { enabled: true } })
    }
  })

  it('uses server-side history on follow-ups and does not rename the conversation', async () => {
    const first = await ask('First question about photosynthesis')
    const second = await ask('And photosynthesis follow-up?', { conversationId: first.prepared.conversationId })
    assert.equal(second.prepared.createdConversation, false)
    const turns = second.ai.calls.chat[0]!.turns
    assert.deepEqual(
      turns.map((turn) => turn.role),
      ['user', 'assistant', 'user'],
    )
    assert.equal(turns[0]!.content, 'First question about photosynthesis')
    assert.match(turns[2]!.content, /<sources>[\s\S]*<\/sources>\s+Question: And photosynthesis follow-up\?/)
    const conversation = await repos.conversations.get(owner.workspaceId, owner.id, first.prepared.conversationId)
    assert.equal(conversation?.title, 'First question about photosynthesis')
  })

  it('merges consecutive user turns left behind by a failed answer (Gemini requires alternation)', async () => {
    const failed = await ask('Photosynthesis question that fails', { ai: { failChat: 'before-stream' } })
    assert.equal(failed.events.at(-1)?.type, 'error')
    const retry = await ask('Photosynthesis again please', { conversationId: failed.prepared.conversationId })
    const roles = retry.ai.calls.chat[0]!.turns.map((turn) => turn.role)
    assert.deepEqual(roles, ['user'])
    assert.match(retry.ai.calls.chat[0]!.turns[0]!.content, /Photosynthesis question that fails[\s\S]*Photosynthesis again please/)
  })

  it('keeps a partial answer when the stream breaks and logs the query as an error', async () => {
    const { types, prepared } = await ask('Photosynthesis breaks midway', { ai: { failChat: 'mid-stream' } })
    assert.deepEqual(types.slice(-2), ['delta', 'error'])
    const stored = await repos.conversations.messages(prepared.conversationId)
    assert.equal(stored.at(-1)?.content, 'Answer ')
    const [log] = await t.db.query<{ status: string }>(`SELECT status FROM app.query_logs WHERE owner_id = $1 AND query = $2`, [owner.id, 'Photosynthesis breaks midway'])
    assert.equal(log?.status, 'error')
  })

  it('refuses conversations and notebooks from another workspace or another member', async () => {
    const theirs = await repos.conversations.create({ workspaceId: stranger.workspaceId, ownerId: stranger.id, collectionId: null, title: 'private' })
    const deps: ChatDeps = { repos, ai: createFakeAi(), reranker: null }
    const is404 = (e: unknown) => e instanceof AppError && e.status === 404
    await assert.rejects(prepareChat(deps, { workspaceId: owner.workspaceId, userId: owner.id, message: 'hi', conversationId: theirs.id, mode: 'standard' }), is404)
    await assert.rejects(prepareChat(deps, { workspaceId: owner.workspaceId, userId: owner.id, message: 'hi', collectionId: stranger.notebookId, mode: 'standard' }), is404)
    // Same workspace, different member: conversations stay private to their author.
    const team = await createTeam(repos, stranger, [[owner, 'viewer']])
    const colleague = await repos.conversations.create({ workspaceId: team.workspaceId, ownerId: stranger.id, collectionId: null, title: 'mine' })
    await assert.rejects(prepareChat(deps, { workspaceId: team.workspaceId, userId: owner.id, message: 'hi', conversationId: colleague.id, mode: 'standard' }), is404)
    assert.equal((await repos.conversations.messages(theirs.id)).length, 0)
  })

  it('deep mode runs multi-query, step-back and HyDE and searches with all of them', async () => {
    const { ai, sources, events } = await ask('Explain photosynthesis', {
      mode: 'deep',
      ai: {
        plan: '```json\n["light energy conversion", "chemical energy", "Explain photosynthesis", "chlorophyll role"]\n```',
        stepBack: '{"question": "How do plants make food?"}',
        hyde: 'Photosynthesis is the process by which plants convert light into chemical energy stored in glucose.',
      },
    })
    assert.equal((events[1] as EventOf<'status'>).stage, 'planning')
    assert.deepEqual(ai.calls.embedQuery, ['Explain photosynthesis', 'light energy conversion', 'chemical energy', 'chlorophyll role', 'How do plants make food?'])
    assert.deepEqual(
      ai.calls.embedDocuments,
      [['Photosynthesis is the process by which plants convert light into chemical energy stored in glucose.']],
      'HyDE passage embedded as a document',
    )
    assert.deepEqual(
      sources!.steps.map((step) => step.label),
      ['Query expansion', 'Step-back question', 'Hypothetical answer (HyDE)', 'Retrieved', 'Re-ranked', 'Relevance check'],
    )
    assert.match(sources!.steps[0]!.detail, /light energy conversion/)
    assert.doesNotMatch(sources!.steps[0]!.detail, /“Explain photosynthesis”/, 'the original question is not repeated as a variant')
    assert.match(sources!.steps.find((s) => s.label === 'Retrieved')!.detail, /from 11 searches/, '5 queries × (vector + keyword) + HyDE')
  })

  it('deep mode survives failing query transforms', async () => {
    const { ai, sources } = await ask('Explain photosynthesis', { mode: 'deep', ai: { failComplete: (input) => !isRerank(input) } })
    assert.deepEqual(ai.calls.embedQuery, ['Explain photosynthesis'])
    assert.match(sources!.steps[0]!.detail, /Unavailable/)
    assert.equal(ai.calls.chat.length, 1)
  })
})

describe('background evaluation', () => {
  it('queues sampled answers and scores them with the judge (faithfulness, relevance, precision)', async () => {
    await t.db.query('DELETE FROM app.jobs')
    await setSettings(owner.workspaceId, { evaluation: { sampleRate: 0.5 } })
    let conversationId: string
    try {
      await ask('What does photosynthesis convert?', { random: () => 0.7 }) // sampled out
      conversationId = (await ask('What does photosynthesis convert?', { random: () => 0.2 })).prepared.conversationId
      await setSettings(owner.workspaceId, { evaluation: { enabled: false } })
      await ask('What does photosynthesis convert?', { random: () => 0 }) // evaluation off
    } finally {
      await setSettings(owner.workspaceId, { evaluation: { enabled: true, sampleRate: 1 } })
    }

    const [queued] = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.jobs WHERE type = 'evaluate_answer'`)
    assert.equal(queued?.n, 1, 'only the sampled answer is queued')

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
    await ask('What does photosynthesis convert?')
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
