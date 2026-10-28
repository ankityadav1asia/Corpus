import { answerText, geminiHttpError } from '@/server/ai/gemini'
import { IMAGE_PROMPTS, transcriptionPrompt, type Transcriber, type VisionModel } from '@/server/ai/media'
import { AiProviderError } from '@/server/ai/provider'
import { recordUsage } from '@/server/ai/usage'

/**
 * Gemini multimodal calls over REST: reading images (OCR + description), transcribing audio/video
 * (inline up to ~14 MB, through the Files API above that) and multi-speaker text-to-speech.
 * The key always travels in a header.
 */

const API = 'https://generativelanguage.googleapis.com'
const INLINE_LIMIT_BYTES = 14 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 300_000
const FILE_READY_TIMEOUT_MS = 180_000

interface GeminiConfig {
  apiKey: string
  model: string
  fetch?: typeof fetch
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean; inlineData?: { mimeType?: string; data?: string } }> }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; totalTokenCount?: number; candidatesTokenCount?: number }
}

const retryable = (status: number) => status === 429 || status >= 500

async function readError(response: Response, label: string): Promise<AiProviderError> {
  let details: unknown
  try {
    details = ((await response.json()) as { error?: { details?: unknown } }).error?.details
  } catch {
    // no JSON body
  }
  return geminiHttpError(label, response.status, details, retryable(response.status))
}

async function request(config: GeminiConfig, url: string, init: RequestInit, label: string, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await (config.fetch ?? fetch)(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'x-goog-api-key': config.apiKey },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch {
    if (signal?.aborted) throw new AiProviderError('Request aborted')
    throw new AiProviderError(`${label} (${timeout.aborted ? 'timeout' : 'network'})`, undefined, true)
  }
  if (!response.ok) throw await readError(response, label)
  return response
}

async function generate(config: GeminiConfig, model: string, body: Record<string, unknown>, label: string, signal?: AbortSignal): Promise<GenerateResponse> {
  const response = await request(
    config,
    `${API}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    label,
    signal,
  )
  const data = (await response.json()) as GenerateResponse
  // Images, audio and video are counted in tokens too; the vendor reports them for every call.
  const usage = data.usageMetadata
  const input = usage?.promptTokenCount ?? 0
  await recordUsage({ model, kind: 'generate', inputTokens: input, outputTokens: usage?.totalTokenCount ? usage.totalTokenCount - input : (usage?.candidatesTokenCount ?? 0), estimated: !usage })
  return data
}

const base64 = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')

/** Uploads through the resumable Files API and waits until the file can be used. */
async function uploadFile(config: GeminiConfig, data: Uint8Array, mimeType: string, displayName: string, signal?: AbortSignal): Promise<{ name: string; uri: string }> {
  const start = await request(
    config,
    `${API}/upload/v1beta/files`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(data.byteLength),
        'X-Goog-Upload-Header-Content-Type': mimeType,
      },
      body: JSON.stringify({ file: { display_name: displayName.slice(0, 100) } }),
    },
    'Gemini file upload failed',
    signal,
  )
  const uploadUrl = start.headers.get('x-goog-upload-url')
  if (!uploadUrl || !uploadUrl.startsWith(`${API}/`)) throw new AiProviderError('Gemini file upload failed (no upload URL)', undefined, true)
  const uploaded = await request(
    config,
    uploadUrl,
    { method: 'POST', headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: new Blob([data as Uint8Array<ArrayBuffer>]) },
    'Gemini file upload failed',
    signal,
  )
  let file = ((await uploaded.json()) as { file?: { name?: string; uri?: string; state?: string } }).file
  if (!file?.name || !file.uri) throw new AiProviderError('Gemini file upload failed (no file)', undefined, true)
  const deadline = Date.now() + FILE_READY_TIMEOUT_MS
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new AiProviderError('Gemini took too long to process the file', undefined, true)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const status = await request(config, `${API}/v1beta/${file.name}`, { method: 'GET' }, 'Gemini file status failed', signal)
    file = { ...file, ...((await status.json()) as { state?: string }) }
  }
  if (file.state === 'FAILED') throw new AiProviderError('Gemini could not process this file')
  return { name: file.name!, uri: file.uri! }
}

async function deleteFile(config: GeminiConfig, name: string) {
  await request(config, `${API}/v1beta/${name}`, { method: 'DELETE' }, 'Gemini file delete failed').catch(() => undefined)
}

export function createGeminiVision(config: GeminiConfig): VisionModel {
  return {
    model: config.model,
    async readImage({ data, mimeType, mode, signal }) {
      const body = { contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: base64(data) } }, { text: IMAGE_PROMPTS[mode] }] }], generationConfig: { temperature: 0 } }
      const response = await generate(config, config.model, body, 'Gemini vision request failed', signal)
      return answerText(response.candidates?.[0]?.content?.parts).trim()
    },
  }
}

export function createGeminiTranscriber(config: GeminiConfig): Transcriber {
  return {
    model: config.model,
    async transcribe({ data, mimeType, fileName, kind, signal }) {
      const prompt = { text: transcriptionPrompt(kind) }
      if (data.byteLength <= INLINE_LIMIT_BYTES) {
        const response = await generate(
          config,
          config.model,
          { contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: base64(data) } }, prompt] }], generationConfig: { temperature: 0 } },
          'Gemini transcription failed',
          signal,
        )
        return answerText(response.candidates?.[0]?.content?.parts).trim()
      }
      const file = await uploadFile(config, data, mimeType, fileName, signal)
      try {
        const response = await generate(
          config,
          config.model,
          { contents: [{ role: 'user', parts: [{ fileData: { mimeType, fileUri: file.uri } }, prompt] }], generationConfig: { temperature: 0 } },
          'Gemini transcription failed',
          signal,
        )
        return answerText(response.candidates?.[0]?.content?.parts).trim()
      } finally {
        await deleteFile(config, file.name)
      }
    },
  }
}
