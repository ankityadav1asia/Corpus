/**
 * Chat streaming protocol: newline-delimited JSON (application/x-ndjson).
 *
 * Every event is a JSON object on its own line, so model output can never be
 * confused with metadata (the old implementation embedded `<!--CITATIONS:...-->`
 * markers inside the answer text, which the model itself could forge).
 */
import type { Citation, RetrievalStep } from '@/lib/contracts'

export type ChatStreamEvent =
  | {
      type: 'start'
      conversationId: string
      conversationTitle: string
      createdConversation: boolean
      userMessageId: string
    }
  /** Progress while retrieval runs (query expansion, search, re-ranking, generation). */
  | { type: 'status'; stage: ChatStage; message: string }
  | { type: 'sources'; citations: Citation[]; steps: RetrievalStep[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; assistantMessageId: string }
  | { type: 'error'; message: string }

export type ChatStage = 'planning' | 'searching' | 'reranking' | 'generating'

export const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8'

const EVENT_TYPES = new Set<ChatStreamEvent['type']>(['start', 'status', 'sources', 'delta', 'done', 'error'])
const encoder = new TextEncoder()

export function encodeEvent(event: ChatStreamEvent): Uint8Array {
  // JSON.stringify escapes newlines inside strings, so one event is always one line.
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

export function parseEvent(line: string): ChatStreamEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && EVENT_TYPES.has(type as ChatStreamEvent['type']) ? (value as ChatStreamEvent) : null
}

/** Decodes an NDJSON byte stream, tolerating events split across network chunks. */
export async function* decodeEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        const event = line ? parseEvent(line) : null
        if (event) yield event
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    const tail = buffer.trim()
    const event = tail ? parseEvent(tail) : null
    if (event) yield event
  } finally {
    reader.releaseLock()
  }
}
