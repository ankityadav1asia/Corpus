import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import type { MediaKind } from '@/lib/contracts'
import { AiProviderError, DAILY_QUOTA_MESSAGE } from '@/server/ai/provider'
import { readUpload } from '@/server/ingestion/extractors'
import { queueMedia } from '@/server/ingestion/ingest-service'
import { runJobs, type JobContext } from '@/server/jobs/runner'
import { readQueuedMedia } from '@/server/media/read-media'
import { createTesseractOcr } from '@/server/media/ocr'
import { reembedWorkspace } from '@/server/rag/reembed'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, createFakeOcr, createFakeTranscriber, createFakeVision, fakeEmbedding, fakeRenderPage, type FakeAi } from './helpers/fake-ai'
import { addDocument, createUser, type TestUser } from './helpers/fixtures'
import { makePdf } from './helpers/pdf'

let t: TestDb
let repos: Repositories
let owner: TestUser

before(async () => {
  t = await createTestDb()
  repos = createRepositories(t.db)
  owner = await createUser(repos, 'studio@example.com', 'Studio Owner')
})

after(() => t.close())

async function resetJobs() {
  await t.db.query('DELETE FROM app.jobs')
}

function context(ai: FakeAi, extra: Partial<JobContext> = {}): JobContext {
  return { repos, ai: () => ai, reranker: () => createLlmReranker(ai), ...extra }
}

function media(kind: MediaKind, fileName: string, data: Uint8Array, mimeType: string, extra: { pageCount?: number; pages?: Array<{ page: number; text: string }> } = {}) {
  return queueMedia(
    repos,
    {
      workspaceId: owner.workspaceId,
      collectionId: owner.notebookId,
      createdBy: owner.id,
      sourceType: 'file',
      source: fileName,
      title: fileName,
      replaceExisting: true,
      byteSize: data.byteLength,
    },
    { kind, mimeType, fileName, data, pageCount: extra.pageCount ?? null, pages: extra.pages ?? [] },
  )
}

async function searchable(query: string) {
  return repos.documents.keywordSearch({ workspaceId: owner.workspaceId, collectionId: owner.notebookId, query, limit: 5 })
}

describe('reading media sources before indexing', () => {
  it('describes an image with the vision model, then indexes the text', async () => {
    await resetJobs()
    const vision = createFakeVision()
    const document = await media('image', 'revenue-chart.png', new Uint8Array(3 * 1024 * 1024).fill(7), 'image/png')
    assert.equal(document.status, 'processing')
    assert.equal(document.mediaKind, 'image')
    assert.equal(document.progress, 'Waiting to read the image')
    assert.equal(
      await t.db.query(`SELECT count(*)::int AS n FROM app.document_media_parts WHERE document_id = $1`, [document.id]).then((rows) => rows[0]!.n),
      2,
      'stored in 2 MB parts',
    )

    const ai = createFakeAi()
    await runJobs(context(ai, { vision: () => vision, ocr: () => createFakeOcr() }), { maxJobs: 10 })
    const ready = await repos.documents.get(owner.workspaceId, document.id)
    assert.equal(ready?.status, 'ready')
    assert.equal(ready?.progress, null)
    assert.equal(vision.calls[0]?.mode, 'describe')
    assert.equal(vision.calls[0]?.bytes, 3 * 1024 * 1024, 'the parts are reassembled')
    assert.ok((await searchable('quarterly revenue')).some((hit) => hit.documentId === document.id))
    const leftovers = await t.db.query(`SELECT count(*)::int AS n FROM app.document_media WHERE document_id = $1`, [document.id])
    assert.equal(leftovers[0]!.n, 0, 'media bytes are dropped once read')
  })

  it('falls back to OCR when the vision model is unavailable', async () => {
    await resetJobs()
    const document = await media('image', 'receipt.png', new Uint8Array([5, 1, 2]), 'image/png')
    await runJobs(context(createFakeAi(), { vision: () => createFakeVision({ fail: true }), ocr: () => createFakeOcr() }), { maxJobs: 10 })
    assert.equal((await repos.documents.get(owner.workspaceId, document.id))?.status, 'ready')
    assert.ok((await searchable('warranty')).some((hit) => hit.documentId === document.id))
  })

  it('transcribes audio with timestamps', async () => {
    await resetJobs()
    const transcriber = createFakeTranscriber()
    const document = await media('audio', 'briefing.mp3', new Uint8Array([0x49, 0x44, 0x33, 1]), 'audio/mpeg')
    await runJobs(context(createFakeAi(), { transcriber: () => transcriber }), { maxJobs: 10 })
    assert.equal((await repos.documents.get(owner.workspaceId, document.id))?.status, 'ready')
    assert.deepEqual(transcriber.calls[0], { fileName: 'briefing.mp3', kind: 'audio', bytes: 4 })
    const detail = await repos.documents.detail(owner.workspaceId, document.id, 10)
    assert.match(detail!.chunks[0]!.content, /\[00:12\] Speaker 2: The satellite launches from Sriharikota/)
  })

  it('fails at once with a clear reason when a capability is turned off, and can be retried later', async () => {
    await resetJobs()
    const document = await media('video', 'demo.mp4', new Uint8Array([0, 0, 0, 24]), 'video/mp4')
    await runJobs(context(createFakeAi()), { maxJobs: 10 })
    const failed = await repos.documents.get(owner.workspaceId, document.id)
    assert.equal(failed?.status, 'failed')
    assert.match(failed!.error!, /Transcribing video is not configured/)
    const [job] = await t.db.query<{ attempts: number }>(`SELECT attempts FROM app.jobs WHERE type = 'read_media'`)
    assert.equal(job?.attempts, 1, 'no pointless retries')

    const retried = await repos.documents.retryIngest(owner.workspaceId, document.id)
    assert.equal(retried?.status, 'processing', 'media that was never read can be retried')
    assert.ok(await repos.media.pending(document.id))
  })

  it('reads a long scan page by page and resumes where the time budget stopped it', async () => {
    const ocr = createFakeOcr()
    const document = await media('scan', 'contract.pdf', new Uint8Array([37, 80, 68, 70]), 'application/pdf', {
      pageCount: 4,
      pages: [{ page: 2, text: 'Page two has a real text layer about the service level agreement.' }],
    })
    const deps = { repos, vision: () => null, transcriber: () => null, ocr: () => ocr, renderPage: fakeRenderPage }
    // A budget that runs out after the first OCR page.
    let first = true
    const deadline = () => {
      const value = first ? Date.now() + 50 : Date.now() + 60_000
      first = false
      return value
    }
    const slowRender = async (pdf: Uint8Array, page: number) => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return fakeRenderPage(pdf, page)
    }
    assert.equal(await readQueuedMedia({ ...deps, renderPage: slowRender }, document.id, deadline()), 'more')
    assert.deepEqual(ocr.pages, [1])
    const progress = (await repos.documents.get(owner.workspaceId, document.id))?.progress
    assert.match(progress ?? '', /Reading scanned pages with OCR \(1\/3\)/)

    assert.equal(await readQueuedMedia(deps, document.id, deadline()), 'done')
    assert.deepEqual(ocr.pages, [1, 3, 4], 'pages already read are not read again; text-layer pages are never OCRed')
    assert.equal(ocr.closed, 2, 'the OCR engine is released after every run')
    const upload = await t.db.query<{ text: string }>(`SELECT text FROM app.document_uploads WHERE document_id = $1`, [document.id])
    const text = upload[0]!.text
    assert.ok(text.indexOf('Scanned page 1') < text.indexOf('Page two') && text.indexOf('Page two') < text.indexOf('Scanned page 3'), 'pages stay in order')
  })

  it('reads a real scanned PDF end to end: text layer where present, Tesseract OCR elsewhere', async () => {
    await resetJobs()
    const pdf = makePdf([
      { text: ['The warranty covers every device sold in 2026.'] },
      { scanned: ['Scanned invoice number 4471', 'Total due: 980 rupees'] },
      { scanned: ['Delivery address: Pune warehouse', 'Signed by the courier'] },
    ])
    const content = await readUpload(new File([Buffer.from(pdf)], 'invoice.pdf'))
    assert.equal(content.type, 'media')
    if (content.type !== 'media') return
    assert.equal(content.kind, 'scan')
    const document = await media('scan', 'invoice.pdf', content.data, content.mimeType, { pageCount: content.pageCount ?? 0, pages: content.pages })
    await runJobs(context(createFakeAi(), { ocr: () => createTesseractOcr({ languages: 'eng' }) }), { maxJobs: 10, timeBudgetMs: 120_000 })
    assert.equal((await repos.documents.get(owner.workspaceId, document.id))?.status, 'ready')
    assert.ok(
      (await searchable('invoice 4471')).some((hit) => hit.documentId === document.id),
      'the scanned page is searchable',
    )
    assert.ok((await searchable('warranty devices')).some((hit) => hit.documentId === document.id))
    assert.ok(
      (await searchable('Pune warehouse courier')).some((hit) => hit.documentId === document.id),
      'every scanned page is read, not just the first',
    )
  })
})

describe('embedding models', () => {
  it('only compares vectors of the same model, and re-embedding brings older passages back', async () => {
    const document = await addDocument(repos, {
      workspaceId: owner.workspaceId,
      collectionId: owner.notebookId,
      createdBy: owner.id,
      title: 'Lighthouse log',
      chunks: ['The lighthouse keeper logs ships at dawn.'],
    })
    await t.db.query(`UPDATE app.chunks SET embedding_model = 'old-model' WHERE document_id = $1`, [document.id])
    const scope = { workspaceId: owner.workspaceId, collectionId: owner.notebookId, embedding: fakeEmbedding('lighthouse keeper ships'), limit: 3 }
    assert.ok(!(await repos.documents.vectorSearch({ ...scope, embeddingModel: 'fake-embedding' })).some((hit) => hit.documentId === document.id))
    assert.ok(
      (await repos.documents.vectorSearch(scope)).some((hit) => hit.documentId === document.id),
      'without a model filter everything is compared',
    )

    const ai = createFakeAi()
    const before = await repos.chunks.embeddingStatus(owner.workspaceId, ai.embeddingModel)
    assert.ok(before.stale >= 1)
    assert.equal(await reembedWorkspace({ repos, ai }, owner.workspaceId, Date.now() + 60_000), 'done')
    assert.equal((await repos.chunks.embeddingStatus(owner.workspaceId, ai.embeddingModel)).stale, 0)
    assert.ok((await repos.documents.vectorSearch({ ...scope, embeddingModel: 'fake-embedding' })).some((hit) => hit.documentId === document.id))
  })
})

describe('background job retries', () => {
  it('rate limits wait as long as asked; a used-up daily quota fails at once', async () => {
    await addDocument(repos, {
      workspaceId: owner.workspaceId,
      collectionId: owner.notebookId,
      createdBy: owner.id,
      title: 'Solar panels',
      chunks: ['Panels convert sunlight into electricity.'],
    })
    const queueReport = async () => {
      const report = await repos.reports.create({
        workspaceId: owner.workspaceId,
        createdBy: owner.id,
        template: 'executive_summary',
        format: 'markdown',
        title: 'Energy summary',
        instructions: null,
        collectionIds: [owner.notebookId],
        documentIds: [],
      })
      await repos.jobs.enqueue('generate_report', { reportId: report.id }, { maxAttempts: JOB_ATTEMPTS.generate_report })
      return report.id
    }
    const failing = (error: AiProviderError) =>
      createFakeAi({
        complete: () => {
          throw error
        },
      })

    await resetJobs()
    const limited = await queueReport()
    await runJobs(context(failing(new AiProviderError('Gemini request failed (429)', 429, true, 90))), { types: ['generate_report'] })
    const [job] = await t.db.query<{ wait: number; status: string }>(`SELECT status, extract(epoch FROM run_after - now())::int AS wait FROM app.jobs`)
    assert.equal(job?.status, 'queued')
    assert.ok(job!.wait >= 85, `retry scheduled after the requested 90s, got ${job!.wait}s`)
    const waiting = await repos.reports.get(owner.workspaceId, limited)
    assert.equal(waiting?.status, 'queued')
    assert.equal(waiting?.progress, 'AI service busy — retrying in ~91 s', 'the card says why it is waiting')

    await resetJobs()
    const exhausted = await queueReport()
    const before = (await repos.notifications.list(owner.id)).items.length
    const quota = failing(new AiProviderError('Gemini request failed (429)', 429, false, 48, true))
    assert.deepEqual(await runJobs(context(quota), { types: ['generate_report'] }), { processed: 0, failed: 1 })
    const [spent] = await t.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM app.jobs`)
    assert.deepEqual([spent?.status, spent?.attempts], ['failed', 1], 'no retries against a used-up daily quota')
    const detail = await repos.reports.get(owner.workspaceId, exhausted)
    assert.equal(detail?.status, 'failed')
    assert.equal(detail?.error, DAILY_QUOTA_MESSAGE)
    const notifications = (await repos.notifications.list(owner.id)).items
    assert.equal(notifications.length, before + 1)
    assert.equal(notifications[0]?.kind, 'report_failed')
  })
})
