import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { createCanvas } from '@napi-rs/canvas'

import { EMBEDDING_DIMENSIONS } from '@/lib/constants'
import { answerText } from '@/server/ai/gemini'
import { createGeminiSpeech, createGeminiTranscriber, createGeminiVision, ttsPrompt } from '@/server/ai/gemini-media'
import { formatTimestamp } from '@/server/ai/media'
import { combineProviders, createOpenAiCompatibleChat, createOpenAiCompatibleEmbeddings, createThinkFilter, fitEmbedding, stripThinking } from '@/server/ai/openai-compatible'
import { createOpenAiCompatibleSpeech, createOpenAiCompatibleTranscriber, createOpenAiCompatibleVision, formatSegments } from '@/server/ai/openai-compatible-media'
import { AiProviderError } from '@/server/ai/provider'
import { getChatBackend, getEmbeddingBackend, getModelSummary, getOcrConfig, getSpeechBackend, getTranscriptionBackend, getVisionBackend, resetEnvCache } from '@/server/env'
import { parseRange } from '@/server/http/range'
import { scannedPages } from '@/server/ingestion/extractors'
import { detectMedia } from '@/server/media/detect'
import { encodeMp3, mp3SampleRate } from '@/server/media/mp3'
import { createTesseractOcr, createVisionOcr } from '@/server/media/ocr'
import { concatPcm, decodeWav, encodeWav, pcmFromL16, resample, sampleRateFromMime } from '@/server/media/wav'
import { createAiProvider } from '@/server/services'

import { createFakeVision } from './helpers/fake-ai'

type Request = { url: string; init: RequestInit; body: unknown }

function mockFetch(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    let body: unknown = init.body
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const request = { url: String(url), init, body }
    requests.push(request)
    return respond(request)
  }) as typeof fetch
  return { requests, fetchImpl }
}

function sse(events: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-line to prove the parser buffers across chunks.
      const text = events.map((event) => `data: ${event}\n\n`).join('')
      controller.enqueue(encoder.encode(text.slice(0, 17)))
      controller.enqueue(encoder.encode(text.slice(17)))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

const delta = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] })

describe('open-source models over the OpenAI dialect', () => {
  it('streams answers, hides <think> reasoning split across chunks, and sends the system prompt first', async () => {
    const { requests, fetchImpl } = mockFetch(() => sse([delta('<thi'), delta('nk>plan the answer</th'), delta('ink>Paris is '), delta('the capital [1].'), '[DONE]']))
    const chat = createOpenAiCompatibleChat({ baseUrl: 'http://localhost:11434/v1/', apiKey: null, model: 'qwen3:8b', fetch: fetchImpl })
    let text = ''
    for await (const part of chat.streamChat({ system: 'Answer from sources', turns: [{ role: 'user', content: 'Capital of France?' }] })) text += part
    assert.equal(text, 'Paris is the capital [1].')
    assert.equal(requests[0]!.url, 'http://localhost:11434/v1/chat/completions')
    const body = requests[0]!.body as { stream: boolean; messages: Array<{ role: string }>; model: string }
    assert.equal(body.stream, true)
    assert.equal(body.model, 'qwen3:8b')
    assert.deepEqual(
      body.messages.map((message) => message.role),
      ['system', 'user'],
    )
    assert.equal((requests[0]!.init.headers as Record<string, string>).Authorization, undefined, 'no key, no header')
  })

  it('asks for JSON mode and falls back when the server does not support it', async () => {
    let calls = 0
    const { requests, fetchImpl } = mockFetch(() => {
      calls++
      return calls === 1 ? new Response('unsupported', { status: 400 }) : Response.json({ choices: [{ message: { content: '<think>hmm</think>{"ok": true}' } }] })
    })
    const chat = createOpenAiCompatibleChat({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'llama3.1', fetch: fetchImpl })
    assert.equal(await chat.complete({ system: 's', prompt: 'p', json: true }), '{"ok": true}')
    assert.deepEqual((requests[0]!.body as { response_format: unknown }).response_format, { type: 'json_object' })
    assert.equal((requests[1]!.body as { response_format?: unknown }).response_format, undefined)
    assert.equal((requests[0]!.init.headers as Record<string, string>).Authorization, 'Bearer sk-test')
  })

  it('maps rate limits to retryable provider errors that carry Retry-After', async () => {
    const { fetchImpl } = mockFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }))
    const chat = createOpenAiCompatibleChat({ baseUrl: 'http://x/v1', apiKey: null, model: 'm', fetch: fetchImpl })
    await assert.rejects(
      chat.complete({ system: 's', prompt: 'p' }),
      (error: unknown) => error instanceof AiProviderError && error.status === 429 && error.retryable && error.retryAfterSeconds === 30,
    )
  })

  it('pads smaller embeddings to the shared column width (cosine similarity unchanged) and rejects larger ones', async () => {
    const padded = fitEmbedding([0.6, 0.8], 'nomic-embed-text')
    assert.equal(padded.length, EMBEDDING_DIMENSIONS)
    assert.deepEqual(padded.slice(0, 3), [0.6, 0.8, 0])
    assert.throws(() => fitEmbedding(new Array(EMBEDDING_DIMENSIONS + 1).fill(0.1), 'huge'), /at most 3072/)
    const { requests, fetchImpl } = mockFetch((request) => {
      const inputs = (request.body as { input: string[] }).input
      // Out of order on purpose: results are matched by index.
      return Response.json({ data: inputs.map((_, index) => ({ index, embedding: [index + 1, 0] })).reverse() })
    })
    const embeddings = createOpenAiCompatibleEmbeddings({ baseUrl: 'http://localhost:11434/v1', apiKey: null, model: 'nomic-embed-text', fetch: fetchImpl })
    const vectors = await embeddings.embedDocuments(['a', 'b', 'c'])
    assert.deepEqual(
      vectors.map((vector) => vector[0]),
      [1, 2, 3],
    )
    assert.equal(embeddings.embeddingModel, 'openai-compatible/nomic-embed-text')
    assert.equal(requests[0]!.url, 'http://localhost:11434/v1/embeddings')
  })

  it('combines separately configured chat and embedding back ends', () => {
    const chat = createOpenAiCompatibleChat({ baseUrl: 'http://a/v1', apiKey: null, model: 'chat-model' })
    const embeddings = createOpenAiCompatibleEmbeddings({ baseUrl: 'http://b/v1', apiKey: null, model: 'embed-model' })
    const provider = combineProviders(chat, embeddings)
    assert.equal(provider.chatModel, 'chat-model')
    assert.equal(provider.embeddingModel, 'openai-compatible/embed-model')
    const mixed = createAiProvider(
      { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKey: null, model: 'llama3.1' },
      { provider: 'gemini', apiKey: 'g'.repeat(39), model: 'gemini-embedding-001' },
    )
    assert.equal(mixed.chatModel, 'llama3.1')
    assert.equal(mixed.embeddingModel, 'gemini-embedding-001')
  })

  it('drops reasoning parts of thinking models served by Gemini (open Gemma models)', () => {
    assert.equal(answerText([{ text: 'reasoning…', thought: true }, { text: '{"ok":true}' }]), '{"ok":true}')
    assert.equal(stripThinking('<think>a</think> b '), 'b')
    const filter = createThinkFilter()
    assert.equal(filter.push('keep <'), 'keep ')
    assert.equal(filter.push('b>'), '<b>', 'a "<" that turns out not to start a tag is released')
    assert.equal(filter.flush(), '')
  })
})

describe('model configuration from the environment', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    resetEnvCache()
  })

  function setEnv(values: Record<string, string | undefined>) {
    for (const key of Object.keys(process.env))
      if (/^(GOOGLE_API_KEY|GEMINI_|CHAT_PROVIDER|EMBEDDING_PROVIDER|OPENAI_COMPATIBLE_|VISION_PROVIDER|TRANSCRIPTION_PROVIDER|TTS_PROVIDER|OCR_)/.test(key))
        delete process.env[key]
    Object.assign(process.env, values)
    resetEnvCache()
  }

  it('runs everything on open-source models without a Gemini key', () => {
    setEnv({
      CHAT_PROVIDER: 'openai-compatible',
      EMBEDDING_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_COMPATIBLE_CHAT_MODEL: 'llama3.1:8b',
      OPENAI_COMPATIBLE_EMBEDDING_MODEL: 'nomic-embed-text',
      OPENAI_COMPATIBLE_VISION_MODEL: 'llava',
      OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL: 'whisper-1',
      OPENAI_COMPATIBLE_TRANSCRIPTION_BASE_URL: 'http://localhost:8000/v1',
      OPENAI_COMPATIBLE_TTS_MODEL: 'kokoro',
      OPENAI_COMPATIBLE_TTS_BASE_URL: 'http://localhost:8880/v1',
    })
    assert.deepEqual(getChatBackend(), { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKey: null, model: 'llama3.1:8b' })
    assert.equal(getEmbeddingBackend().model, 'nomic-embed-text')
    assert.equal(getVisionBackend()?.model, 'llava')
    assert.deepEqual(getTranscriptionBackend(), { provider: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', apiKey: null, model: 'whisper-1' })
    const speech = getSpeechBackend()
    assert.equal(speech?.provider, 'openai-compatible')
    assert.deepEqual(speech?.voices, ['af_heart', 'am_michael'])
    assert.deepEqual(getOcrConfig(), { engine: 'tesseract', languages: 'eng' }, 'OCR defaults to local Tesseract')
    const summary = JSON.stringify(getModelSummary())
    assert.ok(!summary.includes('localhost'), 'the summary never includes URLs')
  })

  it('names the missing variable instead of failing vaguely', () => {
    setEnv({ CHAT_PROVIDER: 'openai-compatible', OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1' })
    assert.throws(() => getChatBackend(), /OPENAI_COMPATIBLE_CHAT_MODEL/)
    setEnv({ CHAT_PROVIDER: 'openai-compatible', OPENAI_COMPATIBLE_CHAT_MODEL: 'x', OPENAI_COMPATIBLE_BASE_URL: 'ftp://nope' })
    assert.throws(() => getChatBackend(), /not a valid http/)
    setEnv({})
    assert.throws(() => getChatBackend(), /GOOGLE_API_KEY/)
    assert.equal(getVisionBackend(), null)
    assert.equal(getSpeechBackend(), null)
  })

  it('defaults multimodal features to Gemini when the key is set, and lets each be turned off', () => {
    setEnv({ GOOGLE_API_KEY: 'k'.repeat(39), GEMINI_CHAT_MODEL: 'gemma-4-26b-a4b-it', TTS_PROVIDER: 'none', OCR_ENGINE: 'vision' })
    assert.equal(getChatBackend().model, 'gemma-4-26b-a4b-it', 'open Gemma models run through the same API')
    assert.equal(getVisionBackend()?.model, 'gemma-4-26b-a4b-it')
    assert.equal(getTranscriptionBackend()?.provider, 'gemini')
    assert.equal(getTranscriptionBackend()?.model, 'gemini-3.6-flash', 'Gemma cannot take audio, so transcription uses a Gemini model')
    assert.equal(getSpeechBackend(), null)
    assert.deepEqual(getOcrConfig(), { engine: 'vision' })
  })
})

describe('multimodal adapters', () => {
  it('sends images to an open vision model as a data URL', async () => {
    const { requests, fetchImpl } = mockFetch(() => Response.json({ choices: [{ message: { content: 'A chart of sales.' } }] }))
    const vision = createOpenAiCompatibleVision({ baseUrl: 'http://localhost:11434/v1', apiKey: null, model: 'llava', fetch: fetchImpl })
    assert.equal(await vision.readImage({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', mode: 'describe' }), 'A chart of sales.')
    const content = (requests[0]!.body as { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> }).messages[0]!.content
    assert.equal(content[1]!.image_url!.url, 'data:image/png;base64,AQID')
  })

  it('transcribes with a Whisper server and turns segments into timestamped paragraphs', async () => {
    const { requests, fetchImpl } = mockFetch(() =>
      Response.json({
        text: 'x',
        segments: [
          { start: 0, text: ' Hello there.' },
          { start: 12, text: 'Same paragraph.' },
          { start: 45, text: 'New topic.' },
        ],
      }),
    )
    const transcriber = createOpenAiCompatibleTranscriber({ baseUrl: 'http://localhost:8000/v1', apiKey: null, model: 'whisper-1', fetch: fetchImpl })
    const text = await transcriber.transcribe({ data: new Uint8Array([1]), mimeType: 'audio/mpeg', fileName: 'talk.mp3', kind: 'audio' })
    assert.equal(text, '[00:00] Hello there. Same paragraph.\n\n[00:45] New topic.')
    assert.ok(requests[0]!.init.body instanceof FormData)
    assert.equal(formatSegments([]), '')
    assert.equal(formatTimestamp(3725), '1:02:05')
  })

  it('records each line with its host voice and joins the audio', async () => {
    const tone = (samples: number, rate: number) => encodeWav(new Int16Array(samples).fill(1000), rate)
    const { requests, fetchImpl } = mockFetch((request) => new Response(tone((request.body as { voice: string }).voice === 'af_heart' ? 2400 : 4800, 24_000)))
    const speech = createOpenAiCompatibleSpeech({ baseUrl: 'http://localhost:8880/v1', apiKey: null, model: 'kokoro', voices: ['af_heart', 'am_michael'], fetch: fetchImpl })
    const result = await speech.synthesize({
      lines: [
        { speaker: 0, text: 'Hi' },
        { speaker: 1, text: 'Hello' },
      ],
    })
    assert.equal(result.sampleRate, 24_000)
    // 0.1 s + 0.25 s pause + 0.2 s + 0.25 s pause
    assert.equal(result.pcm.length, 2400 + 6000 + 4800 + 6000)
    assert.deepEqual(
      requests.map((request) => (request.body as { voice: string }).voice),
      ['af_heart', 'am_michael'],
    )
  })

  it('asks Gemini for a two-voice recording and decodes its raw PCM', async () => {
    const pcm = new Int16Array([1, -2, 3, -4])
    const { requests, fetchImpl } = mockFetch(() =>
      Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.from(pcm.buffer).toString('base64') } }] } }] }),
    )
    const speech = createGeminiSpeech({ apiKey: 'k', model: 'gemini-2.5-flash-preview-tts', fetch: fetchImpl })
    const result = await speech.synthesize({ lines: [{ speaker: 0, text: 'Hello' }] })
    assert.deepEqual([...result.pcm], [1, -2, 3, -4])
    assert.equal(result.sampleRate, 24_000)
    const body = requests[0]!.body as { generationConfig: { responseModalities: string[]; speechConfig: { multiSpeakerVoiceConfig: { speakerVoiceConfigs: unknown[] } } } }
    assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO'])
    assert.equal(body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs.length, 2)
    assert.match(ttsPrompt([{ speaker: 1, text: 'Yes' }]), /Host B: Yes/)
    assert.equal((requests[0]!.init.headers as Record<string, string>)['x-goog-api-key'], 'k')
  })

  it('reads images with Gemini inline and uploads large recordings through the Files API', async () => {
    const vision = createGeminiVision({
      apiKey: 'k',
      model: 'gemini-x',
      fetch: mockFetch(() => Response.json({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'A diagram.' }] } }] })).fetchImpl,
    })
    assert.equal(await vision.readImage({ data: new Uint8Array([1]), mimeType: 'image/png', mode: 'ocr' }), 'A diagram.')

    const { requests, fetchImpl } = mockFetch((request) => {
      if (request.url.endsWith('/upload/v1beta/files'))
        return new Response(null, { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session/1' } })
      if (request.url.includes('/upload/session/'))
        return Response.json({ file: { name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', state: 'ACTIVE' } })
      if (request.init.method === 'DELETE') return Response.json({})
      return Response.json({ candidates: [{ content: { parts: [{ text: '[00:00] Hello.' }] } }] })
    })
    const transcriber = createGeminiTranscriber({ apiKey: 'k', model: 'gemini-x', fetch: fetchImpl })
    const big = new Uint8Array(15 * 1024 * 1024)
    assert.equal(await transcriber.transcribe({ data: big, mimeType: 'audio/mpeg', fileName: 'long.mp3', kind: 'audio' }), '[00:00] Hello.')
    assert.deepEqual(
      requests.map((request) => request.init.method ?? 'GET'),
      ['POST', 'POST', 'POST', 'DELETE'],
    )
    const generate = requests[2]!.body as { contents: Array<{ parts: Array<{ fileData?: { fileUri: string } }> }> }
    assert.equal(generate.contents[0]!.parts[0]!.fileData!.fileUri, 'https://generativelanguage.googleapis.com/v1beta/files/abc', 'the file is referenced, not inlined')
  })
})

describe('audio and file helpers', () => {
  it('round-trips WAV, resamples and joins PCM', () => {
    const source = new Int16Array([0, 1000, -1000, 32767, -32768])
    const decoded = decodeWav(encodeWav(source, 16_000))
    assert.deepEqual([...decoded.pcm], [...source])
    assert.equal(decoded.sampleRate, 16_000)
    assert.equal(resample(new Int16Array(24_000), 24_000, 16_000).length, 16_000)
    assert.equal(concatPcm([new Int16Array(2), new Int16Array(3)]).length, 5)
    assert.deepEqual([...pcmFromL16(new Uint8Array([1, 0, 255, 255]))], [1, -1])
    assert.equal(sampleRateFromMime('audio/L16;codec=pcm;rate=16000'), 16_000)
    assert.throws(() => decodeWav(new Uint8Array(10)), /Not a WAV/)
  })

  it('encodes speech as MP3 frames', async () => {
    const pcm = new Int16Array(24_000).map((_, i) => Math.round(Math.sin(i / 10) * 5000))
    const mp3 = await encodeMp3(pcm, 24_000)
    assert.ok(mp3.byteLength > 1000 && mp3.byteLength < 20_000, `one second at 64 kbit/s, got ${mp3.byteLength} bytes`)
    const frame = mp3.findIndex((byte, i) => byte === 0xff && ((mp3[i + 1] ?? 0) & 0xe0) === 0xe0)
    assert.ok(frame >= 0, 'contains an MP3 frame header')
    assert.equal(mp3SampleRate(23_500), 24_000)
    assert.equal(mp3SampleRate(23_000), 22_050)
  })

  it('verifies media by content, not by name', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    assert.deepEqual(detectMedia(png, '.png'), { kind: 'image', mimeType: 'image/png' })
    assert.equal(detectMedia(png, '.jpg'), null, 'a PNG renamed to .jpg is rejected')
    assert.deepEqual(detectMedia(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]), '.mp3'), { kind: 'audio', mimeType: 'audio/mpeg' })
    assert.deepEqual(detectMedia(encodeWav(new Int16Array(4), 8000), '.wav'), { kind: 'audio', mimeType: 'audio/wav' })
    const mp4 = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom'), 0, 0])
    assert.deepEqual(detectMedia(mp4, '.mp4'), { kind: 'video', mimeType: 'video/mp4' })
    assert.deepEqual(detectMedia(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0]), '.webm'), { kind: 'video', mimeType: 'video/webm' })
    assert.equal(detectMedia(new TextEncoder().encode('<html>'), '.mp4'), null)
  })

  it('finds the scanned pages of a PDF', () => {
    const pdf = {
      total: 4,
      pages: [
        { page: 1, text: 'A full page of real text that is long enough.' },
        { page: 2, text: '' },
        { page: 4, text: '7' },
      ],
    }
    assert.deepEqual(scannedPages(pdf), [2, 3, 4])
  })

  it('parses byte ranges for seeking', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
    assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 })
    assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
    assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 })
    assert.equal(parseRange('bytes=2000-', 1000), null)
    assert.equal(parseRange('items=0-1', 1000), null)
  })
})

describe('OCR', () => {
  it('reads text from an image with the bundled open-source engine (offline)', async () => {
    const canvas = createCanvas(900, 200)
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 900, 200)
    context.fillStyle = '#111111'
    context.font = '36px sans-serif'
    context.fillText('Invoice total: 4200 rupees', 30, 90)
    context.fillText('Due date: 12 March 2027', 30, 150)
    const png = new Uint8Array(await canvas.encode('png'))
    const ocr = createTesseractOcr({ languages: 'eng' })
    try {
      const result = await ocr.recognize({ data: png, mimeType: 'image/png' })
      assert.match(result.text, /Invoice total: 4200 rupees/)
      assert.match(result.text, /12 March 2027/)
      assert.ok((result.confidence ?? 0) > 60)
    } finally {
      await ocr.close()
      await ocr.close()
    }
  })

  it('can use a vision model for OCR instead', async () => {
    const vision = createFakeVision()
    const ocr = createVisionOcr(vision)
    assert.match((await ocr.recognize({ data: new Uint8Array([1]), mimeType: 'image/jpeg' })).text, /revenue/)
    assert.deepEqual(vision.calls[0], { mimeType: 'image/jpeg', mode: 'ocr', bytes: 1 })
  })
})
