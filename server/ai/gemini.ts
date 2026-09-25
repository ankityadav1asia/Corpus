import { GoogleGenerativeAI, GoogleGenerativeAIFetchError, TaskType, type Content } from '@google/generative-ai'

import { EMBEDDING_DIMENSIONS } from '@/lib/constants'
import { AiProviderError, type AiProvider, type ChatTurn } from '@/server/ai/provider'

const EMBED_BATCH_SIZE = 100 // batchEmbedContents limit
const EMBED_CONCURRENCY = 3
const MAX_ATTEMPTS = 4
/** Longer server-requested waits (per-minute quotas) are left to the caller: retrying sooner only burns quota. */
const MAX_INLINE_RETRY_WAIT_SECONDS = 5

interface GeminiConfig {
  apiKey: string
  chatModel: string
  embeddingModel: string
  /** Model for short helper calls (`fast: true`); defaults to the chat model. */
  fastModel?: string | null
}

/**
 * Turning thinking off for helper calls. Gemini 3 models take a thinking level, 2.x models a budget.
 * A model that rejects the setting (some open models) is remembered and asked without it.
 */
const THINKING_UNSUPPORTED = new Set<string>()

export function thinkingOffConfig(model: string): Record<string, unknown> {
  return /^gemini-3/i.test(model) ? { thinkingLevel: 'low' } : { thinkingBudget: 0 }
}

function rejectsThinkingConfig(error: unknown): boolean {
  return error instanceof GoogleGenerativeAIFetchError && error.status === 400 && /thinking/i.test(error.message)
}

/** Runs a request with thinking turned off when asked, falling back to the model's default once. */
async function withThinkingChoice<T>(model: string, fast: boolean, run: (thinkingOff: boolean) => Promise<T>): Promise<T> {
  const off = fast && !THINKING_UNSUPPORTED.has(model)
  try {
    return await run(off)
  } catch (error) {
    if (!off || !rejectsThinkingConfig(error)) throw error
    THINKING_UNSUPPORTED.add(model)
    return run(false)
  }
}

function generationConfig(model: string, base: Record<string, unknown>, thinkingOff: boolean) {
  // The SDK passes generationConfig through to the REST API; its types predate thinkingConfig.
  return (thinkingOff ? { ...base, thinkingConfig: thinkingOffConfig(model) } : base) as Record<string, unknown> & { temperature?: number }
}

function isRetryable(status: number | undefined) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

/** Google reports the suggested wait as a RetryInfo detail, e.g. { "@type": "…RetryInfo", "retryDelay": "37s" }. */
export function parseRetryDelay(details: unknown): number | undefined {
  if (!Array.isArray(details)) return undefined
  for (const detail of details) {
    const { '@type': type, retryDelay } = (detail ?? {}) as { '@type'?: unknown; retryDelay?: unknown }
    if (typeof type !== 'string' || !type.endsWith('RetryInfo') || typeof retryDelay !== 'string') continue
    const seconds = Number.parseFloat(retryDelay)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds
  }
  return undefined
}

/**
 * A QuotaFailure naming a per-day quota (e.g. "GenerateRequestsPerDayPerProjectPerModel-FreeTier"):
 * the limit resets once a day, or is zero on this plan, so retrying within minutes only burns attempts.
 */
export function isDailyQuotaFailure(details: unknown): boolean {
  if (!Array.isArray(details)) return false
  return details.some((detail) => {
    const violations = (detail as { violations?: unknown } | null)?.violations
    return Array.isArray(violations) && violations.some((violation) => /PerDay/i.test(String((violation as { quotaId?: unknown } | null)?.quotaId ?? '')))
  })
}

/** Maps a failed Gemini HTTP response to a provider error (shared by the chat and image adapters). */
export function geminiHttpError(label: string, status: number | undefined, details: unknown, retryable: boolean): AiProviderError {
  const daily = status === 429 && isDailyQuotaFailure(details)
  return new AiProviderError(`${label} (${status ?? 'network'})`, status, retryable && !daily, parseRetryDelay(details), daily)
}

function toProviderError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error
  if (error instanceof GoogleGenerativeAIFetchError) {
    return geminiHttpError('Gemini request failed', error.status, error.errorDetails, isRetryable(error.status))
  }
  const name = (error as { name?: string })?.name
  if (name === 'AbortError') return new AiProviderError('Request aborted')
  return new AiProviderError('Gemini request failed', undefined, true)
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new AiProviderError('Request aborted'))
      },
      { once: true },
    )
  })
}

/** Exponential backoff with jitter for rate limits and transient 5xx errors. */
async function withRetry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const providerError = toProviderError(error)
      const requestedWait = providerError.retryAfterSeconds ?? 0
      if (!providerError.retryable || attempt >= MAX_ATTEMPTS || signal?.aborted || requestedWait > MAX_INLINE_RETRY_WAIT_SECONDS) throw providerError
      await sleep(Math.max(2 ** attempt * 250 + Math.random() * 250, requestedWait * 1000), signal)
    }
  }
}

function assertEmbedding(values: number[] | undefined): number[] {
  if (!values || values.length !== EMBEDDING_DIMENSIONS) {
    // LangChain used to swallow failed batches as [] and store empty vectors; fail loudly instead.
    throw new AiProviderError(`Embedding model returned ${values?.length ?? 0} dimensions; expected ${EMBEDDING_DIMENSIONS}. Check GEMINI_EMBEDDING_MODEL.`)
  }
  return values
}

/**
 * The answer text of a response. Thinking models served through this API (e.g. open Gemma models)
 * return their reasoning as parts marked `thought: true`; those are never shown or parsed.
 */
export function answerText(parts: ReadonlyArray<{ text?: string; thought?: boolean }> | undefined): string {
  return (parts ?? [])
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? '')
    .join('')
}

function toContents(turns: readonly ChatTurn[]): Content[] {
  return turns.map((turn) => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] }))
}

export function createGeminiProvider(config: GeminiConfig): AiProvider {
  const client = new GoogleGenerativeAI(config.apiKey)
  const embedder = client.getGenerativeModel({ model: config.embeddingModel })

  async function embedBatch(texts: readonly string[], taskType: TaskType, signal?: AbortSignal) {
    const response = await withRetry(
      () => embedder.batchEmbedContents({ requests: texts.map((text) => ({ content: { role: 'user', parts: [{ text }] }, taskType })) }, { signal }),
      signal,
    )
    if (response.embeddings.length !== texts.length) {
      throw new AiProviderError(`Embedding batch returned ${response.embeddings.length} vectors for ${texts.length} inputs`)
    }
    return response.embeddings.map((embedding) => assertEmbedding(embedding.values))
  }

  async function embedAll(texts: readonly string[], taskType: TaskType, signal?: AbortSignal) {
    const batches: string[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) batches.push(texts.slice(i, i + EMBED_BATCH_SIZE))
    const results: number[][][] = new Array(batches.length)
    let next = 0
    async function worker() {
      while (next < batches.length) {
        const index = next++
        results[index] = await embedBatch(batches[index]!, taskType, signal)
      }
    }
    await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, batches.length) }, worker))
    return results.flat()
  }

  return {
    chatModel: config.chatModel,
    embeddingModel: config.embeddingModel,

    embedDocuments(texts, signal) {
      return embedAll(texts, TaskType.RETRIEVAL_DOCUMENT, signal)
    },

    async embedQuery(text, signal) {
      const response = await withRetry(() => embedder.embedContent({ content: { role: 'user', parts: [{ text }] }, taskType: TaskType.RETRIEVAL_QUERY }, { signal }), signal)
      return assertEmbedding(response.embedding.values)
    },

    embedQueries(texts, signal) {
      return embedAll(texts, TaskType.RETRIEVAL_QUERY, signal)
    },

    async *streamChat({ system, turns, fast = false, signal }) {
      const name = config.chatModel
      const start = (thinkingOff: boolean) =>
        client
          .getGenerativeModel({ model: name, systemInstruction: system, generationConfig: generationConfig(name, { temperature: 0.2 }, thinkingOff) })
          .generateContentStream({ contents: toContents(turns) }, { signal })
      // Only the initial request is retried; a stream that fails midway is surfaced to the caller.
      const result = await withRetry(() => withThinkingChoice(name, fast, start), signal)
      try {
        for await (const chunk of result.stream) {
          const text = answerText(chunk.candidates?.[0]?.content?.parts)
          if (text) yield text
        }
      } catch (error) {
        throw toProviderError(error)
      }
    },

    async complete({ system, prompt, json, temperature, fast = false, signal }) {
      const name = fast && config.fastModel ? config.fastModel : config.chatModel
      const base = { temperature: temperature ?? 0, ...(json ? { responseMimeType: 'application/json' } : {}) }
      const run = (thinkingOff: boolean) =>
        client
          .getGenerativeModel({ model: name, systemInstruction: system, generationConfig: generationConfig(name, base, thinkingOff) })
          .generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }, { signal })
      const result = await withRetry(() => withThinkingChoice(name, fast, run), signal)
      return answerText(result.response.candidates?.[0]?.content?.parts)
    },
  }
}
