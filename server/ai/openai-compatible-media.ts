import { IMAGE_PROMPTS, formatTimestamp, type SpeechSynthesizer, type Transcriber, type VisionModel } from '@/server/ai/media'
import { authHeaders, endpoint, postWithRetry, stripThinking, type OpenAiCompatibleConfig } from '@/server/ai/openai-compatible'
import { AiProviderError } from '@/server/ai/provider'
import { concatPcm, decodeWav, resample, silence } from '@/server/media/wav'

/**
 * Open-source multimodal models over the OpenAI dialect:
 *   vision        — /chat/completions with an image part (llava, qwen2.5-vl, gemma3 …)
 *   transcription — /audio/transcriptions (Whisper servers: faster-whisper-server, whisper.cpp, LocalAI, Groq …)
 *   speech        — /audio/speech (Kokoro-FastAPI, openedai-speech, LocalAI …), one request per line
 */

export function createOpenAiCompatibleVision(config: OpenAiCompatibleConfig): VisionModel {
  const doFetch = config.fetch ?? fetch
  return {
    model: config.model,
    async readImage({ data, mimeType, mode, signal }) {
      const body = {
        model: config.model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: IMAGE_PROMPTS[mode] },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${Buffer.from(data).toString('base64')}` } },
            ],
          },
        ],
      }
      const response = await postWithRetry(
        doFetch,
        endpoint(config.baseUrl, '/chat/completions'),
        { headers: { 'Content-Type': 'application/json', ...authHeaders(config.apiKey) }, body: JSON.stringify(body) },
        'Vision request failed',
        signal,
      )
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> }
      return stripThinking(json.choices?.[0]?.message?.content ?? '')
    },
  }
}

interface WhisperResponse {
  text?: string
  segments?: Array<{ start?: number; text?: string }>
}

/** Groups Whisper segments into paragraphs of roughly 30 seconds, each starting with its timestamp. */
export function formatSegments(segments: NonNullable<WhisperResponse['segments']>): string {
  const paragraphs: string[] = []
  let current: { start: number; text: string[] } | null = null
  for (const segment of segments) {
    const text = (segment.text ?? '').trim()
    if (!text) continue
    const start = segment.start ?? 0
    if (!current || start - current.start >= 30) {
      if (current) paragraphs.push(`[${formatTimestamp(current.start)}] ${current.text.join(' ')}`)
      current = { start, text: [] }
    }
    current.text.push(text)
  }
  if (current) paragraphs.push(`[${formatTimestamp(current.start)}] ${current.text.join(' ')}`)
  return paragraphs.join('\n\n')
}

export function createOpenAiCompatibleTranscriber(config: OpenAiCompatibleConfig): Transcriber {
  const doFetch = config.fetch ?? fetch
  return {
    model: config.model,
    async transcribe({ data, mimeType, fileName, signal }) {
      const form = new FormData()
      form.set('file', new Blob([Buffer.from(data)], { type: mimeType }), fileName)
      form.set('model', config.model)
      form.set('response_format', 'verbose_json')
      const response = await postWithRetry(
        doFetch,
        endpoint(config.baseUrl, '/audio/transcriptions'),
        { headers: authHeaders(config.apiKey), body: form },
        'Transcription request failed',
        signal,
      )
      const json = (await response.json()) as WhisperResponse
      if (json.segments?.length) return formatSegments(json.segments)
      return (json.text ?? '').trim()
    },
  }
}

export function createOpenAiCompatibleSpeech(config: OpenAiCompatibleConfig & { voices: readonly [string, string] }): SpeechSynthesizer {
  const doFetch = config.fetch ?? fetch
  return {
    model: config.model,
    voices: config.voices,
    async synthesize({ lines, signal }) {
      const parts: Int16Array[] = []
      let sampleRate = 0
      for (const line of lines) {
        const response = await postWithRetry(
          doFetch,
          endpoint(config.baseUrl, '/audio/speech'),
          {
            headers: { 'Content-Type': 'application/json', ...authHeaders(config.apiKey) },
            body: JSON.stringify({ model: config.model, input: line.text, voice: config.voices[line.speaker], response_format: 'wav' }),
          },
          'Speech request failed',
          signal,
        )
        let decoded
        try {
          decoded = decodeWav(new Uint8Array(await response.arrayBuffer()))
        } catch {
          throw new AiProviderError('The speech server did not return WAV audio (response_format=wav)')
        }
        sampleRate ||= decoded.sampleRate
        parts.push(resample(decoded.pcm, decoded.sampleRate, sampleRate), silence(0.25, sampleRate))
      }
      if (!sampleRate) throw new AiProviderError('No speech was produced')
      return { pcm: concatPcm(parts), sampleRate }
    },
  }
}
