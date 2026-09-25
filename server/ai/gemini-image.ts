import { geminiHttpError } from '@/server/ai/gemini'
import { ImageRefusedError, type ImageGenerator } from '@/server/ai/image'
import { AiProviderError } from '@/server/ai/provider'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const TIMEOUT_MS = 120_000
/** Finish / block reasons that mean "refused", not "try again". */
const REFUSALS = new Set(['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_PROHIBITED_CONTENT', 'RECITATION', 'IMAGE_RECITATION'])

interface GeminiPart {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
  promptFeedback?: { blockReason?: string }
}

export interface GeminiImageConfig {
  apiKey: string
  model: string
  fetch?: typeof fetch
}

function isRetryable(status: number) {
  return status === 429 || status >= 500
}

/**
 * Gemini native image models (gemini-*-image) through the REST API: the prompt goes in as text,
 * the picture comes back as an inline base64 part. The key travels in a header, never in the URL.
 */
export function createGeminiImageGenerator(config: GeminiImageConfig): ImageGenerator {
  const doFetch = config.fetch ?? fetch
  return {
    model: config.model,
    async generate({ prompt, aspectRatio, signal }) {
      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      let response: Response
      try {
        response = await doFetch(`${ENDPOINT}/${encodeURIComponent(config.model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } },
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      } catch {
        if (signal?.aborted) throw new AiProviderError('Request aborted')
        throw new AiProviderError(`Gemini image request failed (${timeout.aborted ? 'timeout' : 'network'})`, undefined, true)
      }

      if (!response.ok) {
        let details: unknown
        try {
          details = ((await response.json()) as { error?: { details?: unknown } }).error?.details
        } catch {
          // no JSON body
        }
        throw geminiHttpError('Gemini image request failed', response.status, details, isRetryable(response.status))
      }

      const body = (await response.json()) as GeminiResponse
      const candidate = body.candidates?.[0]
      const parts = candidate?.content?.parts ?? []
      const image = parts.find((part) => typeof part.inlineData?.data === 'string' && part.inlineData.data.length > 0)
      if (!image?.inlineData?.data) {
        const reason = body.promptFeedback?.blockReason ?? candidate?.finishReason
        if (reason && REFUSALS.has(reason)) throw new ImageRefusedError()
        // Occasionally the model answers with text only; a new attempt usually produces an image.
        throw new AiProviderError('The image model returned no image', undefined, true)
      }
      const text = parts
        .map((part) => part.text ?? '')
        .join('\n')
        .trim()
      return {
        data: new Uint8Array(Buffer.from(image.inlineData.data, 'base64')),
        mimeType: image.inlineData.mimeType ?? 'image/png',
        text: text || null,
      }
    },
  }
}
