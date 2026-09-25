import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import type { MediaKind } from '@/lib/contracts'
import { readUpload } from '@/server/ingestion/extractors'
import { queueMedia } from '@/server/ingestion/ingest-service'
import { runJobs, type JobContext } from '@/server/jobs/runner'
import { readQueuedMedia } from '@/server/media/read-media'
import { createTesseractOcr } from '@/server/media/ocr'
import { reembedWorkspace } from '@/server/rag/reembed'
import { createLlmReranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { generateAudio, parseScript, synthesisChunks, timeTranscript } from '@/server/studio/audio'
import { countNodes, parseMindMap } from '@/server/studio/mindmap'

import { createTestDb, type TestDb } from './helpers/db'
import { createFakeAi, createFakeOcr, createFakeSpeech, createFakeTranscriber, createFakeVision, fakeEmbedding, fakeRenderPage, type FakeAi } from './helpers/fake-ai'
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
  return { repos, ai: () => ai, reranker: () => createLlmReranker(ai), images: () => null, ...extra }
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

describe('mind maps', () => {
  it('trims whatever the model returns into a bounded, well-formed tree', () => {
    const deep = (level: number): unknown => ({ label: `Level ${level}`, children: level < 9 ? [deep(level + 1), deep(level + 1)] : [] })
    const parsed = parseMindMap(`Here you go:\n\`\`\`json\n${JSON.stringify({ title: '**Big** map', root: deep(1) })}\n\`\`\``, 2, { nodes: 20, depth: 4 })
    assert.equal(parsed.title, 'Big map')
    assert.ok(countNodes(parsed.root) <= 20)
    const depth = (node: { children: unknown[] }): number => 1 + Math.max(0, ...node.children.map((child) => depth(child as { children: unknown[] })))
    assert.equal(depth(parsed.root), 4)
    const withSources = parseMindMap(JSON.stringify({ label: 'Root', children: [{ label: 'A', sources: [1, 7, '2', 2] }] }), 2)
    assert.deepEqual(withSources.root.children[0]!.sources, [1, 2], 'out-of-range and duplicate source numbers are dropped')
    assert.throws(() => parseMindMap('{"root": {"label": "Only a root"}}', 1), /no branches/)
  })

  it('builds a mind map from the selected notebook in the background and notifies the author', async () => {
    await resetJobs()
    await addDocument(repos, {
      workspaceId: owner.workspaceId,
      collectionId: owner.notebookId,
      createdBy: owner.id,
      title: 'Solar panels',
      chunks: ['Panels convert sunlight into electricity.'],
    })
    const map = await repos.mindMaps.create({
      workspaceId: owner.workspaceId,
      createdBy: owner.id,
      title: 'Mind map',
      focus: 'energy',
      collectionIds: [owner.notebookId],
      documentIds: [],
    })
    await repos.jobs.enqueue('generate_mindmap', { mindMapId: map.id }, { maxAttempts: JOB_ATTEMPTS.generate_mindmap })
    const ai = createFakeAi()
    await runJobs(context(ai), { maxJobs: 5 })
    const detail = await repos.mindMaps.get(owner.workspaceId, map.id)
    assert.equal(detail?.status, 'completed')
    assert.equal(detail?.title, 'Topics in the sources')
    assert.ok(detail!.root!.children.some((branch) => branch.label === 'Solar panels'))
    assert.equal(detail?.nodeCount, countNodes(detail!.root!))
    assert.ok(detail!.sources.some((source) => source.title === 'Solar panels'))
    const reduce = ai.calls.complete.find((call) => call.system.startsWith('Build a mind map'))
    assert.match(reduce!.prompt, /Focus the map on: energy/)
    assert.equal((await repos.notifications.list(owner.id)).items[0]?.kind, 'mindmap_ready')
  })
})

describe('audio overviews', () => {
  it('parses scripts leniently and times the transcript from the recording', () => {
    const script = parseScript(
      JSON.stringify({
        title: 'Episode',
        lines: [
          { speaker: 'Host A', text: 'Welcome **back** to the show [1].' },
          { speaker: 'b', text: 'Thanks! See https://example.com for more.' },
          { speaker: 'unknown', text: 'Who speaks now? The other host.' },
          { speaker: 'A', text: 'x'.repeat(1000) + '.' },
        ],
      }),
    )
    assert.deepEqual(
      script.lines.slice(0, 3).map((line) => line.speaker),
      [0, 1, 0],
    )
    assert.equal(script.lines[0]!.text, 'Welcome back to the show .')
    assert.ok(!script.lines[1]!.text.includes('https://'))
    assert.ok(script.lines.every((line) => line.text.length <= 900))
    const chunks = synthesisChunks(script.lines, 100, 2)
    assert.equal(chunks[0]!.start, 0)
    assert.equal(chunks.at(-1)!.end, script.lines.length)
    const transcript = timeTranscript(
      script.lines,
      chunks,
      chunks.map(() => 1000),
    )
    assert.equal(transcript[0]!.start, 0)
    assert.ok(transcript.every((segment, index) => segment.end >= segment.start && (index === 0 || segment.start >= transcript[index - 1]!.start)))
    assert.throws(() => parseScript('{"lines": [{"speaker": "A", "text": "Hi"}]}'), /too short/)
  })

  it('writes a grounded script, records it in resumable segments and serves one MP3', async () => {
    await resetJobs()
    await addDocument(repos, {
      workspaceId: owner.workspaceId,
      collectionId: owner.notebookId,
      createdBy: owner.id,
      title: 'Rainwater harvesting',
      chunks: ['Rooftop tanks store monsoon rain.'],
    })
    const overview = await repos.audio.create({
      workspaceId: owner.workspaceId,
      createdBy: owner.id,
      title: 'Audio overview',
      format: 'deep_dive',
      length: 'short',
      language: 'Hinglish',
      focus: null,
      collectionIds: [owner.notebookId],
      documentIds: [],
    })
    const ai = createFakeAi()
    // The speech model fails after the first segment: the job retries later and resumes.
    const flaky = createFakeSpeech({ failAfter: 1 })
    await assert.rejects(generateAudio({ repos, ai, speech: flaky }, overview.id, Date.now() + 60_000), /speech failed/)
    const partial = await repos.audio.segments(overview.id)
    assert.equal(partial.length, 1)
    const scriptCalls = ai.calls.complete.filter((call) => call.system.startsWith('You write the script')).length
    assert.equal(scriptCalls, 1)
    assert.match(ai.calls.complete.find((call) => call.system.startsWith('You write the script'))!.system, /Hinglish/)

    const speech = createFakeSpeech()
    assert.equal(await generateAudio({ repos, ai, speech }, overview.id, Date.now() + 60_000), 'done')
    assert.equal(ai.calls.complete.filter((call) => call.system.startsWith('You write the script')).length, 1, 'the script is not rewritten on resume')
    const detail = await repos.audio.get(owner.workspaceId, overview.id)
    assert.equal(detail?.status, 'completed')
    assert.equal(detail?.title, 'A tour of the sources')
    assert.deepEqual(detail?.voices, ['Alpha', 'Beta'])
    assert.ok((detail?.durationSeconds ?? 0) > 1)
    assert.ok(detail!.transcript.length >= 4)
    assert.ok(detail!.sources.some((source) => source.title === 'Rainwater harvesting'))
    const file = await repos.audio.file(overview.id)
    assert.equal(file?.data.byteLength, detail?.byteSize)
    assert.equal(file?.data[0], 0xff, 'starts with an MP3 frame')
    assert.equal((await repos.notifications.list(owner.id)).items[0]?.kind, 'audio_ready')
  })

  it('fails with a clear reason when no speech model is configured', async () => {
    await resetJobs()
    const overview = await repos.audio.create({
      workspaceId: owner.workspaceId,
      createdBy: owner.id,
      title: 'Audio overview',
      format: 'brief',
      length: 'short',
      language: 'English',
      focus: null,
      collectionIds: [owner.notebookId],
      documentIds: [],
    })
    await repos.jobs.enqueue('generate_audio', { audioId: overview.id }, { maxAttempts: JOB_ATTEMPTS.generate_audio })
    await runJobs(context(createFakeAi()), { types: ['generate_audio'] })
    const detail = await repos.audio.get(owner.workspaceId, overview.id)
    assert.equal(detail?.status, 'failed')
    assert.match(detail!.error!, /text-to-speech/)
  })
})
