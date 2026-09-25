import { EMBEDDING_DIMENSIONS } from '@/lib/constants'
import { ImageRefusedError, type ImageGenerator } from '@/server/ai/image'
import type { SpeechSynthesizer, SpokenLine, Transcriber, VisionModel } from '@/server/ai/media'
import { AiProviderError, type AiProvider, type ChatTurn, type CompletionInput } from '@/server/ai/provider'
import { JUDGE_SYSTEM } from '@/server/evaluation/judge'
import { IMAGE_DIRECTOR_SYSTEM } from '@/server/images/generate'
import { HYDE_SYSTEM, STEP_BACK_SYSTEM } from '@/server/rag/query-transform'
import type { OcrEngine } from '@/server/media/ocr'
import { FOLLOWUP_SYSTEM } from '@/server/rag/followups'
import { LLM_RERANK_SYSTEM } from '@/server/rag/rerank'

/** Deterministic bag-of-words embedding: texts sharing words get high cosine similarity. */
export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  vector[0] = 0.05 // never a zero vector (cosine distance would be NaN)
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261
    for (const ch of token) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619)
    vector[1 + (Math.abs(hash) % (EMBEDDING_DIMENSIONS - 1))]! += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return vector.map((value) => value / norm)
}

const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 3))

/** Share of the question's (longer) words that appear in the passage, 0–10. */
function overlapScore(question: string, passage: string): number {
  const asked = words(question)
  if (asked.size === 0) return 0
  const present = words(passage)
  let hits = 0
  for (const word of asked) if (present.has(word)) hits++
  return Math.round((hits / asked.size) * 10)
}

/** Grades passages like a real re-ranker would, but by word overlap. */
export function fakeRerankOutput(prompt: string): string {
  const question = /^Question: (.*)$/m.exec(prompt)?.[1] ?? ''
  const passages = [...prompt.matchAll(/<passage id="(\d+)">\n([\s\S]*?)\n<\/passage>/g)]
  return JSON.stringify(passages.map((match) => ({ id: Number(match[1]), score: overlapScore(question, match[2]!) })))
}

/** A judge that finds every claim supported and every passage relevant. */
export function fakeJudgeOutput(prompt: string): string {
  const passageCount = [...prompt.matchAll(/<passage id="(\d+)">/g)].length
  const hasReference = prompt.includes('<reference>')
  return JSON.stringify({
    claims: [
      { claim: 'first claim', supported: true },
      { claim: 'second claim', supported: true },
    ],
    answer_relevance: 5,
    passages: Array.from({ length: passageCount }, (_, index) => ({ id: index + 1, relevant: true })),
    reference_statements: hasReference ? [{ statement: 'reference statement', attributable: true }] : null,
  })
}

export interface FakeAiOptions {
  answer?: string[]
  /** Multi-query expansion output (deep mode). */
  plan?: string
  stepBack?: string
  hyde?: string
  /** Replaces the default output for any completion; return undefined to fall back to the default. */
  complete?: (input: CompletionInput) => string | undefined | Promise<string | undefined>
  /** Makes matching completions throw (e.g. only the re-ranker). */
  failComplete?: (input: CompletionInput) => boolean
  failEmbedding?: boolean
  failChat?: 'before-stream' | 'mid-stream'
}

export interface FakeAi extends AiProvider {
  calls: {
    embedDocuments: string[][]
    /** Every search query embedded, single or batched, in order. */
    embedQuery: string[]
    chat: Array<{ system: string; turns: ChatTurn[]; fast?: boolean }>
    complete: CompletionInput[]
  }
}

export const isRerank = (input: CompletionInput) => input.system === LLM_RERANK_SYSTEM
export const isJudge = (input: CompletionInput) => input.system === JUDGE_SYSTEM
export const isMultiQuery = (input: CompletionInput) => input.system.startsWith('You generate search queries')
export const isImageDirector = (input: CompletionInput) => input.system === IMAGE_DIRECTOR_SYSTEM
export const isFollowups = (input: CompletionInput) => input.system === FOLLOWUP_SYSTEM

/** An image brief built from the first source, so tests can check the brief is grounded in it. */
export function fakeImageBrief(prompt: string): string {
  const source = /<source id="1"[^>]*>\n([\s\S]*?)\n<\/source>/.exec(prompt)?.[1] ?? 'no sources'
  return JSON.stringify({ title: 'Grounded picture', prompt: `An infographic that shows: ${source.slice(0, 200)}`, alt: 'A labelled infographic.' })
}

export const isMindMap = (input: CompletionInput) => input.system.startsWith('Build a mind map')
export const isAudioScript = (input: CompletionInput) => input.system.startsWith('You write the script of an audio overview')

const documentTitles = (prompt: string) => [...prompt.matchAll(/<document id="(\d+)" title="([^"]*)">/g)].map((match) => match[2]!)

/** A small topic tree with one branch per document, citing it. */
export function fakeMindMap(prompt: string): string {
  const titles = documentTitles(prompt)
  return JSON.stringify({
    title: 'Topics in the sources',
    root: {
      label: 'Knowledge base',
      children: titles.map((title, index) => ({
        label: title,
        summary: `Key points from ${title}.`,
        sources: [index + 1],
        children: [
          { label: `${title} details`, sources: [index + 1], children: [] },
          { label: `${title} numbers`, children: [] },
        ],
      })),
    },
  })
}

/** A short two-host script that mentions every document. */
export function fakeAudioScript(prompt: string): string {
  const titles = documentTitles(prompt)
  const lines = [
    { speaker: 'A', text: 'Welcome back! Today we dig into the sources you shared.' },
    { speaker: 'B', text: `We have ${titles.length} of them, so let us get started.` },
    ...titles.flatMap((title) => [
      { speaker: 'A', text: `First up is ${title}. What stood out to you?` },
      { speaker: 'B', text: `The key points of ${title} are surprisingly concrete [1].` },
    ]),
    // Enough conversation for several recording segments.
    ...Array.from({ length: 12 }, (_, index) => ({ speaker: index % 2 ? 'B' : 'A', text: `Point ${index + 1}: the sources back this up with a concrete example.` })),
    { speaker: 'A', text: 'That is a wrap. Thanks for listening!' },
  ]
  return JSON.stringify({ title: 'A tour of the sources', lines })
}

function defaultCompletion(input: CompletionInput, options: FakeAiOptions): string {
  if (isMindMap(input)) return fakeMindMap(input.prompt)
  if (isAudioScript(input)) return fakeAudioScript(input.prompt)
  if (isMultiQuery(input)) return options.plan ?? '["alpha search", "beta search", "gamma search"]'
  if (input.system === STEP_BACK_SYSTEM) return options.stepBack ?? '{"question": "What is the general background of this topic?"}'
  if (input.system === HYDE_SYSTEM) return options.hyde ?? 'A hypothetical passage that explains the topic in several plausible sentences.'
  if (isRerank(input)) return fakeRerankOutput(input.prompt)
  if (isJudge(input)) return fakeJudgeOutput(input.prompt)
  if (isImageDirector(input)) return fakeImageBrief(input.prompt)
  if (isFollowups(input)) return '{"questions": ["How does it compare over time?", "Which numbers matter most?", "Who is affected?"]}'
  if (input.json) {
    return JSON.stringify({ title: 'Deck', subtitle: 'Generated', slides: [{ title: 'Overview', bullets: ['First point [1]', 'Second point'], notes: 'Say hello' }] })
  }
  return `Generated text for: ${input.prompt.slice(0, 40)}`
}

/** A real 1×1 PNG. */
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

export interface FakeImages extends ImageGenerator {
  calls: Array<{ prompt: string; aspectRatio: string }>
}

/** Image model double: returns TINY_PNG, or fails the way the real adapter does. */
export function createFakeImages(options: { behaviour?: 'ok' | 'refuse' | 'rate-limit' | 'daily-quota' | 'garbage' } = {}): FakeImages {
  const calls: FakeImages['calls'] = []
  return {
    model: 'fake-image-model',
    calls,
    async generate({ prompt, aspectRatio }) {
      calls.push({ prompt, aspectRatio })
      if (options.behaviour === 'refuse') throw new ImageRefusedError()
      if (options.behaviour === 'rate-limit') throw new AiProviderError('Gemini image request failed (429)', 429, true, 90)
      if (options.behaviour === 'daily-quota') throw new AiProviderError('Gemini image request failed (429)', 429, false, 48, true)
      const data = options.behaviour === 'garbage' ? new TextEncoder().encode('<html>not an image</html>') : new Uint8Array(TINY_PNG)
      return { data, mimeType: 'image/png', text: null }
    },
  }
}

export function createFakeAi(options: FakeAiOptions = {}): FakeAi {
  const calls: FakeAi['calls'] = { embedDocuments: [], embedQuery: [], chat: [], complete: [] }
  return {
    calls,
    chatModel: 'fake-model',
    embeddingModel: 'fake-embedding',
    async embedDocuments(texts) {
      calls.embedDocuments.push([...texts])
      if (options.failEmbedding) throw new AiProviderError('embedding failed', 503, true)
      return texts.map(fakeEmbedding)
    },
    async embedQuery(text) {
      calls.embedQuery.push(text)
      if (options.failEmbedding) throw new AiProviderError('embedding failed', 503, true)
      return fakeEmbedding(text)
    },
    async embedQueries(texts) {
      calls.embedQuery.push(...texts)
      if (options.failEmbedding) throw new AiProviderError('embedding failed', 503, true)
      return texts.map(fakeEmbedding)
    },
    async *streamChat({ system, turns, fast }) {
      calls.chat.push({ system, turns: turns.map((turn) => ({ ...turn })), fast })
      if (options.failChat === 'before-stream') throw new AiProviderError('chat failed', 500, true)
      const parts = options.answer ?? ['Answer ', 'from ', 'sources [1].']
      for (const [index, part] of parts.entries()) {
        if (options.failChat === 'mid-stream' && index === 1) throw new AiProviderError('stream broke', 500, false)
        yield part
      }
    },
    async complete(input) {
      calls.complete.push(input)
      if (options.failComplete?.(input)) throw new AiProviderError('completion failed', 503, true)
      const custom = await options.complete?.(input)
      return custom ?? defaultCompletion(input, options)
    },
  }
}

// ---------- Multimodal doubles ----------

export interface FakeVision extends VisionModel {
  calls: Array<{ mimeType: string; mode: string; bytes: number }>
}

export function createFakeVision(options: { fail?: boolean } = {}): FakeVision {
  const calls: FakeVision['calls'] = []
  return {
    model: 'fake-vision',
    calls,
    async readImage({ data, mimeType, mode }) {
      calls.push({ mimeType, mode, bytes: data.byteLength })
      if (options.fail) throw new AiProviderError('vision failed', 503, true)
      return 'Quarterly revenue grew 12 percent to 4.2 million.\n\nDescription: a bar chart of revenue by quarter with four labelled bars.'
    },
  }
}

export function createFakeTranscriber(): Transcriber & { calls: Array<{ fileName: string; kind: string; bytes: number }> } {
  const calls: Array<{ fileName: string; kind: string; bytes: number }> = []
  return {
    model: 'fake-transcriber',
    calls,
    async transcribe({ data, fileName, kind }) {
      calls.push({ fileName, kind, bytes: data.byteLength })
      return '[00:00] Speaker 1: Welcome to the Orion mission briefing.\n\n[00:12] Speaker 2: The satellite launches from Sriharikota in May 2027.'
    },
  }
}

/** Speaks every line as 0.4 s of a quiet tone, so recordings have real, measurable length. */
export function createFakeSpeech(options: { failAfter?: number } = {}): SpeechSynthesizer & { calls: number } {
  const double = {
    model: 'fake-tts',
    voices: ['Alpha', 'Beta'] as const,
    calls: 0,
    async synthesize({ lines }: { lines: readonly SpokenLine[] }) {
      double.calls++
      if (options.failAfter !== undefined && double.calls > options.failAfter) throw new AiProviderError('speech failed', 503, true)
      const sampleRate = 24_000
      const pcm = new Int16Array(Math.round(0.4 * sampleRate * lines.length))
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 8) * 2000)
      return { pcm, sampleRate }
    },
  }
  return double
}

/** OCR double: reads the "page number" that the fake PDF renderer writes into the first byte. */
export function createFakeOcr(): OcrEngine & { pages: number[]; closed: number } {
  const double = {
    name: 'fake-ocr',
    pages: [] as number[],
    closed: 0,
    async recognize({ data }: { data: Uint8Array; mimeType: string }) {
      double.pages.push(data[0] ?? 0)
      return { text: `Scanned page ${data[0]} says the warranty lasts ${(data[0] ?? 0) + 1} years.`, confidence: 91 }
    },
    async close() {
      double.closed++
    },
  }
  return double
}

/** Renders "page n" as a one-byte image carrying n. */
export const fakeRenderPage = async (_pdf: Uint8Array, page: number) => new Uint8Array([page, 1, 2, 3])
