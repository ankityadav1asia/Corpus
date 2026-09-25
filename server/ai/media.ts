/**
 * Multimodal capabilities, each behind a small interface (like AiProvider) so the vendor — Gemini or
 * any OpenAI-compatible open-source server — can be swapped, and tests can use fakes.
 */

export type ImageReadMode = 'ocr' | 'describe'

export interface VisionModel {
  readonly model: string
  /** `ocr`: transcribe the visible text. `describe`: transcribe the text and describe charts, diagrams and photos. */
  readImage(input: { data: Uint8Array; mimeType: string; mode: ImageReadMode; signal?: AbortSignal }): Promise<string>
}

export type MediaKind = 'audio' | 'video'

export interface Transcriber {
  readonly model: string
  transcribe(input: { data: Uint8Array; mimeType: string; fileName: string; kind: MediaKind; signal?: AbortSignal }): Promise<string>
}

/** One spoken line of a two-host script. */
export interface SpokenLine {
  speaker: 0 | 1
  text: string
}

export interface SynthesizedSpeech {
  /** 16-bit mono PCM samples. */
  pcm: Int16Array
  sampleRate: number
}

export interface SpeechSynthesizer {
  readonly model: string
  /** Display names of the two voices (host A, host B). */
  readonly voices: readonly [string, string]
  synthesize(input: { lines: readonly SpokenLine[]; signal?: AbortSignal }): Promise<SynthesizedSpeech>
}

export const IMAGE_PROMPTS: Record<ImageReadMode, string> = {
  ocr: 'Transcribe all text in this image exactly as written, in reading order. Keep line breaks, render tables as Markdown tables, and do not add commentary. If there is no text, reply with nothing.',
  describe:
    'Make this image searchable. First transcribe every piece of visible text in reading order (tables as Markdown). Then, under the heading "Description:", describe what the image shows: for charts and diagrams the type, axes, labels, values and the relationships or trend; for photos the subjects, setting and notable details. Be factual; do not speculate beyond what is visible.',
}

export function transcriptionPrompt(kind: MediaKind): string {
  const visual = kind === 'video' ? ' Where the picture carries information (slides, on-screen text, demonstrations), add a line "[On screen: …]" at that point.' : ''
  return `Transcribe this ${kind} verbatim in its original language. Start a new paragraph whenever the speaker or topic changes and begin each paragraph with its timestamp as [mm:ss] (or [h:mm:ss]). When several people speak, label them consistently (Speaker 1, Speaker 2, or their names if they are introduced).${visual} Return only the transcript.`
}

/** Seconds → "mm:ss" / "h:mm:ss". */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(h ? 2 : 1, '0')
  return h ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm.padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
