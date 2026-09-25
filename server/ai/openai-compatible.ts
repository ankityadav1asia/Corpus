import { EMBEDDING_DIMENSIONS } from '@/lib/constants'
import { AiProviderError, type AiProvider, type ChatTurn } from '@/server/ai/provider'

/**
 * Adapter for any server that speaks the OpenAI REST dialect — the usual way to run open-source
 * models: Ollama (http://localhost:11434/v1), vLLM, LM Studio, LocalAI, llama.cpp server, or hosted
 * open-model APIs (Groq, Together, OpenRouter, Fireworks …).
 */

export interface OpenAiCompatibleConfig {
  baseUrl: string
  /** Optional: local servers usually need none. */
  apiKey: string | null
  model: string
  /** Model for short helper calls (`fast: true`); defaults to `model`. */
  fastModel?: string | null
  fetch?: typeof fetch
}

const REQUEST_TIMEOUT_MS = 180_000
const MAX_ATTEMPTS = 3
const MAX_INLINE_RETRY_WAIT_SECONDS = 5
const EMBED_BATCH_SIZE = 64

export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

export function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (!header) return undefined
  const seconds = Number.parseFloat(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/** Turns a failed response into a provider error (never includes the body: it can echo the prompt). */
export function httpError(label: string, response: Response): AiProviderError {
  const status = response.status
  return new AiProviderError(`${label} (${status})`, status, status === 429 || status >= 500, retryAfterSeconds(response))
}

/** POST with timeout and a couple of retries for rate limits and 5xx. */
export async function postWithRetry(
  doFetch: typeof fetch,
  url: string,
  init: { headers: Record<string, string>; body: BodyInit },
  label: string,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await doFetch(url, { method: 'POST', headers: init.headers, body: init.body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch {
      if (signal?.aborted) throw new AiProviderError('Request aborted')
      const error = new AiProviderError(`${label} (${timeout.aborted ? 'timeout' : 'network'})`, undefined, true)
      if (attempt >= MAX_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 250))
      continue
    }
    if (response.ok) return response
    const error = httpError(label, response)
    await response.body?.cancel().catch(() => undefined)
    const wait = error.retryAfterSeconds ?? 0
    if (!error.retryable || attempt >= MAX_ATTEMPTS || wait > MAX_INLINE_RETRY_WAIT_SECONDS) throw error
    await new Promise((resolve) => setTimeout(resolve, Math.max(2 ** attempt * 250, wait * 1000)))
  }
}

/**
 * Many open reasoning models (DeepSeek-R1, Qwen3, …) put their reasoning inside <think>…</think>.
 * The filter removes it from streamed text, including tags split across chunks.
 */
export function createThinkFilter() {
  let inside = false
  let pending = ''
  const OPEN = '<think>'
  const CLOSE = '</think>'

  function push(chunk: string): string {
    let text = pending + chunk
    pending = ''
    let visible = ''
    while (text) {
      const tag = inside ? CLOSE : OPEN
      const at = text.indexOf(tag)
      if (at !== -1) {
        if (!inside) visible += text.slice(0, at)
        text = text.slice(at + tag.length)
        inside = !inside
        continue
      }
      // Keep a possible partial tag at the end for the next chunk.
      let keep = 0
      for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
        if (tag.startsWith(text.slice(text.length - length))) {
          keep = length
          break
        }
      }
      if (!inside) visible += text.slice(0, text.length - keep)
      pending = text.slice(text.length - keep)
      text = ''
    }
    return visible
  }

  return {
    push,
    flush(): string {
      const rest = inside ? '' : pending
      pending = ''
      return rest
    },
  }
}

export function stripThinking(text: string): string {
  const filter = createThinkFilter()
  return (filter.push(text) + filter.flush()).trim()
}

/** Reads `data: …` lines of a server-sent event stream. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) yield line.slice(5).trim()
      }
    }
    const last = buffer.trim()
    if (last.startsWith('data:')) yield last.slice(5).trim()
  } finally {
    reader.releaseLock()
  }
}

function messages(system: string, turns: readonly ChatTurn[]) {
  return [{ role: 'system', content: system }, ...turns.map((turn) => ({ role: turn.role, content: turn.content }))]
}

type ChatPart = Pick<AiProvider, 'chatModel' | 'streamChat' | 'complete'>
type EmbeddingPart = Pick<AiProvider, 'embeddingModel' | 'embedDocuments' | 'embedQuery' | 'embedQueries'>

export function createOpenAiCompatibleChat(config: OpenAiCompatibleConfig): ChatPart {
  const doFetch = config.fetch ?? fetch
  const url = endpoint(config.baseUrl, '/chat/completions')
  const headers = { 'Content-Type': 'application/json', ...authHeaders(config.apiKey) }

  async function completion(body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const response = await postWithRetry(doFetch, url, { headers, body: JSON.stringify(body) }, 'Model request failed', signal)
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> }
    return stripThinking(data.choices?.[0]?.message?.content ?? '')
  }

  return {
    chatModel: config.model,

    async *streamChat({ system, turns, signal }) {
      const response = await postWithRetry(
        doFetch,
        url,
        { headers, body: JSON.stringify({ model: config.model, messages: messages(system, turns), temperature: 0.2, stream: true }) },
        'Model request failed',
        signal,
      )
      if (!response.body) throw new AiProviderError('Model returned no stream')
      const filter = createThinkFilter()
      try {
        for await (const data of sseData(response.body)) {
          if (data === '[DONE]') break
          let delta = ''
          try {
            delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> }).choices?.[0]?.delta?.content ?? ''
          } catch {
            continue // keep-alive comments and malformed lines
          }
          const visible = filter.push(delta)
          if (visible) yield visible
        }
      } catch (error) {
        if (error instanceof AiProviderError) throw error
        throw new AiProviderError(signal?.aborted ? 'Request aborted' : 'Model stream failed', undefined, false)
      }
      const rest = filter.flush()
      if (rest) yield rest
    },

    async complete({ system, prompt, json, temperature, fast, signal }) {
      const body = {
        model: fast && config.fastModel ? config.fastModel : config.model,
        messages: messages(system, [{ role: 'user', content: prompt }]),
        temperature: temperature ?? 0,
      }
      if (!json) return completion(body, signal)
      try {
        return await completion({ ...body, response_format: { type: 'json_object' } }, signal)
      } catch (error) {
        // Some servers do not support JSON mode; the parsers are lenient, so ask again without it.
        if (error instanceof AiProviderError && (error.status === 400 || error.status === 422)) return completion(body, signal)
        throw error
      }
    },
  }
}

/**
 * Open embedding models are usually smaller than 3072 dimensions (nomic-embed-text 768, bge-m3 1024 …).
 * Zero-padding keeps dot products and norms — so cosine similarity — unchanged, which lets every model
 * share the one `vector(3072)` column. Larger vectors are rejected.
 */
export function fitEmbedding(values: readonly number[], model: string): number[] {
  if (values.length === 0) throw new AiProviderError(`Embedding model ${model} returned an empty vector`)
  if (values.length > EMBEDDING_DIMENSIONS) {
    throw new AiProviderError(`Embedding model ${model} returns ${values.length} dimensions; at most ${EMBEDDING_DIMENSIONS} are supported.`)
  }
  if (values.length === EMBEDDING_DIMENSIONS) return [...values]
  const padded = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  for (let i = 0; i < values.length; i++) padded[i] = values[i]!
  return padded
}

export function createOpenAiCompatibleEmbeddings(config: OpenAiCompatibleConfig): EmbeddingPart {
  const doFetch = config.fetch ?? fetch
  const url = endpoint(config.baseUrl, '/embeddings')
  const headers = { 'Content-Type': 'application/json', ...authHeaders(config.apiKey) }

  async function embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const response = await postWithRetry(
      doFetch,
      url,
      { headers, body: JSON.stringify({ model: config.model, input: texts, encoding_format: 'float' }) },
      'Embedding request failed',
      signal,
    )
    const data = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> }
    const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    if (rows.length !== texts.length) throw new AiProviderError(`Embedding batch returned ${rows.length} vectors for ${texts.length} inputs`)
    return rows.map((row) => fitEmbedding(row.embedding ?? [], config.model))
  }

  async function embedAll(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const results: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) results.push(...(await embedBatch(texts.slice(i, i + EMBED_BATCH_SIZE), signal)))
    return results
  }

  return {
    embeddingModel: `openai-compatible/${config.model}`,
    embedDocuments: (texts, signal) => embedAll(texts, signal),
    embedQueries: (texts, signal) => embedAll(texts, signal),
    async embedQuery(text, signal) {
      const [vector] = await embedBatch([text], signal)
      if (!vector) throw new AiProviderError('No embedding returned')
      return vector
    },
  }
}

/** One AiProvider from separately configured chat and embedding back ends. */
export function combineProviders(chat: ChatPart, embeddings: EmbeddingPart): AiProvider {
  return {
    chatModel: chat.chatModel,
    streamChat: chat.streamChat,
    complete: chat.complete,
    embeddingModel: embeddings.embeddingModel,
    embedDocuments: embeddings.embedDocuments,
    embedQuery: embeddings.embedQuery,
    embedQueries: embeddings.embedQueries,
  }
}
