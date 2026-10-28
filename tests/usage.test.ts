import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import { createGeminiVision } from '@/server/ai/gemini-media'
import { createOpenAiCompatibleChat, createOpenAiCompatibleEmbeddings } from '@/server/ai/openai-compatible'
import type { CompletionInput } from '@/server/ai/provider'
import { estimateTokens, recordUsage, setUsageSink, withUsageScope, type UsageEntry } from '@/server/ai/usage'
import { runJobs } from '@/server/jobs/runner'
import { createRepositories, type Repositories } from '@/server/repositories'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi } from './helpers/fake-ai'
import { addDocument, createUser, type TestUser } from './helpers/fixtures'

let recorded: UsageEntry[] = []

function capture() {
  recorded = []
  setUsageSink(async (entry) => {
    recorded.push(entry)
  })
}

afterEach(() => setUsageSink(null))

describe('AI usage metering', () => {
  it('bills calls to the innermost scope and skips calls outside a workspace', async () => {
    capture()
    const call = { model: 'm', kind: 'generate' as const, inputTokens: 10, outputTokens: 2.4, estimated: false }
    await recordUsage(call)
    await withUsageScope({ workspaceId: 'w1', userId: 'u1', feature: 'corpus' }, async () => {
      await recordUsage(call)
      await withUsageScope({ feature: 'generate_report', userId: null }, () => recordUsage({ ...call, inputTokens: -5 }))
    })
    assert.deepEqual(
      recorded.map((entry) => [entry.workspaceId, entry.userId, entry.feature, entry.inputTokens, entry.outputTokens]),
      [
        ['w1', 'u1', 'corpus', 10, 2],
        ['w1', null, 'generate_report', 0, 2],
      ],
    )
    assert.equal(estimateTokens(['abcd', 'efghi']), 3)
  })

  it('never fails the model call when the usage row cannot be stored', async () => {
    setUsageSink(async () => {
      throw new Error('relation "app.ai_usage" does not exist')
    })
    await withUsageScope({ workspaceId: 'w1' }, () => recordUsage({ model: 'm', kind: 'embed', inputTokens: 1, outputTokens: 0, estimated: true }))
  })

  it('reads token counts from OpenAI-compatible servers, and estimates them when a server does not say', async () => {
    capture()
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).endsWith('/embeddings')
        ? Response.json({ data: [{ embedding: [0.1], index: 0 }] })
        : Response.json({ choices: [{ message: { content: 'Answer' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } })) as typeof fetch
    const chat = createOpenAiCompatibleChat({ baseUrl: 'http://x/v1', apiKey: null, model: 'llama', fetch: fetchImpl })
    const embeddings = createOpenAiCompatibleEmbeddings({ baseUrl: 'http://x/v1', apiKey: null, model: 'nomic', fetch: fetchImpl })
    await withUsageScope({ workspaceId: 'w1', feature: 'chat' }, async () => {
      assert.equal(await chat.complete({ system: 's', prompt: 'p' }), 'Answer')
      await embeddings.embedQuery('12345678')
    })
    assert.deepEqual(
      recorded.map((entry) => [entry.model, entry.kind, entry.inputTokens, entry.outputTokens, entry.estimated]),
      [
        ['llama', 'generate', 12, 5, false],
        ['openai-compatible/nomic', 'embed', 2, 0, true],
      ],
    )
  })

  it('meters Gemini media calls (vision, transcription, speech) from their usage metadata', async () => {
    capture()
    const fetchImpl = (async () =>
      Response.json({ candidates: [{ content: { parts: [{ text: 'A chart of rainfall.' }] } }], usageMetadata: { promptTokenCount: 258, totalTokenCount: 270 } })) as typeof fetch
    const vision = createGeminiVision({ apiKey: 'k'.repeat(20), model: 'gemini-flash', fetch: fetchImpl })
    await withUsageScope({ workspaceId: 'w1', feature: 'read_media' }, () => vision.readImage({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', mode: 'describe' }))
    assert.deepEqual(
      recorded.map((entry) => [entry.feature, entry.model, entry.inputTokens, entry.outputTokens]),
      [['read_media', 'gemini-flash', 258, 12]],
    )
  })
})

describe('usage of background jobs', () => {
  let t: TestDb
  let repos: Repositories
  let owner: TestUser

  before(async () => {
    t = await createTestDb()
    repos = createRepositories(t.db)
    owner = await createUser(repos, 'metered@example.com', 'Metered')
  })

  after(async () => {
    await t.close()
  })

  it('bills a job to the workspace and member it works for, and purges old rows', async () => {
    setUsageSink((entry) => repos.usage.record(entry))
    for (const title of ['Rain', 'Wind']) {
      await addDocument(repos, { workspaceId: owner.workspaceId, collectionId: owner.notebookId, createdBy: owner.id, title, chunks: [`${title} data for the season.`] })
    }
    const report = await repos.reports.create({
      workspaceId: owner.workspaceId,
      createdBy: owner.id,
      template: 'executive_summary',
      format: 'markdown',
      title: 'Weather',
      instructions: null,
      collectionIds: [owner.notebookId],
      documentIds: [],
    })
    await repos.jobs.enqueue('generate_report', { reportId: report.id }, { maxAttempts: 1 })
    // A provider that meters like the real ones do.
    const fake = createFakeAi()
    const ai = {
      ...fake,
      async complete(input: CompletionInput) {
        await recordUsage({ model: 'fake-model', kind: 'generate', inputTokens: 100, outputTokens: 10, estimated: false })
        return fake.complete(input)
      },
    }
    assert.deepEqual(await runJobs({ repos, ai: () => ai, reranker: () => null }, { types: ['generate_report'] }), { processed: 1, failed: 0 })

    const rows = await t.db.query(`SELECT workspace_id, user_id, feature, count(*)::int AS calls FROM app.ai_usage GROUP BY 1, 2, 3`)
    assert.deepEqual(
      rows.map((row) => [row.workspace_id, row.user_id, row.feature, row.calls]),
      [[owner.workspaceId, owner.id, 'generate_report', fake.calls.complete.length]],
    )
    assert.deepEqual(await repos.usage.jobOwner('generate_report', { reportId: '00000000-0000-4000-8000-000000000000' }), { workspaceId: null, userId: null })
    assert.deepEqual(await repos.usage.jobOwner('unknown', {}), { workspaceId: null, userId: null })

    await t.db.query(`UPDATE app.ai_usage SET created_at = now() - interval '500 days'`)
    assert.equal(await repos.usage.purgeOlderThan(400), rows[0]!.calls)
  })
})
