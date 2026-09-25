import { NDJSON_CONTENT_TYPE, encodeEvent, type ChatStreamEvent } from '@/lib/stream-protocol'
import { log } from '@/server/logger'

/**
 * Pull-based NDJSON response: the generator only advances when the client reads, and a client
 * disconnect cancels the stream, aborts the model call and lets the generator clean up.
 */
export function ndjsonResponse(events: AsyncGenerator<ChatStreamEvent>, abort: AbortController): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next()
        if (done) controller.close()
        else controller.enqueue(encodeEvent(value))
      } catch (error) {
        log.error('Stream generator crashed', error)
        controller.enqueue(encodeEvent({ type: 'error', message: 'Something went wrong while answering. Please try again.' }))
        controller.close()
      }
    },
    async cancel() {
      abort.abort()
      await events.return(undefined)
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': NDJSON_CONTENT_TYPE,
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
