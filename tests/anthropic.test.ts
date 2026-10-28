import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import Anthropic from '@anthropic-ai/sdk'

import { createAnthropicChat, REFUSAL_MESSAGE } from '@/server/ai/anthropic'
import { AiProviderError } from '@/server/ai/provider'
import { setUsageSink, withUsageScope, type UsageEntry } from '@/server/ai/usage'
import { getChatBackend, getFastChatModel, resetEnvCache } from '@/server/env'

type Sent = { body: Record<string, unknown>; beta: string | null }

/** A Claude client whose requests are answered in-process. */
function fakeClient(reply: (body: Record<string, unknown>) => Response) {
  const sent: Sent[] = []
  const fetch = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    sent.push({ body, beta: new Headers(init.headers).get('anthropic-beta') })
    return reply(body)
  }) as typeof globalThis.fetch
  return { client: new Anthropic({ apiKey: 'sk-ant-test', fetch, maxRetries: 0 }), sent }
}

const message = (text: string, stopReason = 'end_turn') =>
  Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 80, output_tokens: 6 },
  })

function sse(events: object[]) {
  const text = events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

const streamed = (stopReason: string) =>
  sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Bees ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'pollinate [1].' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ])

afterEach(() => {
  setUsageSink(null)
  for (const name of ['CHAT_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CHAT_MODEL', 'ANTHROPIC_FAST_MODEL']) delete process.env[name]
  resetEnvCache()
})

describe('Claude for answers', () => {
  it('asks with effort instead of sampling settings, caches the system prompt and opts into refusal fallbacks', async () => {
    const recorded: UsageEntry[] = []
    setUsageSink(async (entry) => {
      recorded.push(entry)
    })
    const { client, sent } = fakeClient(() => message('[1,2]'))
    const chat = createAnthropicChat({ apiKey: 'sk-ant-test', model: 'claude-opus-5-5', fastModel: 'claude-haiku-5-5', client })
    await withUsageScope({ workspaceId: 'w1', feature: 'generate_report' }, async () => {
      assert.equal(await chat.complete({ system: 'Grade passages.', prompt: 'p', json: true, temperature: 0.3 }), '[1,2]')
      await chat.complete({ system: 's', prompt: 'p', fast: true })
    })
    const [full, fast] = sent
    assert.equal(full!.body.model, 'claude-opus-5-5')
    assert.deepEqual(full!.body.output_config, { effort: 'medium' })
    assert.equal(full!.body.fallbacks, 'default')
    assert.equal(full!.beta, 'server-side-fallback-2026-07-01')
    assert.deepEqual(full!.body.system, [{ type: 'text', text: 'Grade passages.', cache_control: { type: 'ephemeral' } }])
    assert.equal(full!.body.temperature, undefined, 'Claude takes no sampling settings')
    // The fast model (Haiku) has no server-side fallback, so none is asked for.
    assert.equal(fast!.body.model, 'claude-haiku-5-5')
    assert.deepEqual(fast!.body.output_config, { effort: 'low' })
    assert.equal(fast!.body.fallbacks, undefined)
    assert.deepEqual(
      recorded.map((entry) => [entry.feature, entry.inputTokens, entry.outputTokens, entry.estimated]),
      [
        ['generate_report', 100, 6, false],
        ['generate_report', 100, 6, false],
      ],
    )
  })

  it('streams only the answer text, and reports refusals and vendor errors without their details', async () => {
    let stop = 'end_turn'
    const { client } = fakeClient((body) =>
      body.stream ? streamed(stop) : Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'echo of the prompt' } }, { status: 400 }),
    )
    const chat = createAnthropicChat({ apiKey: 'sk-ant-test', model: 'claude-opus-5-5', client })
    const read = async () => {
      let text = ''
      for await (const part of chat.streamChat({ system: 'Answer from sources.', turns: [{ role: 'user', content: 'q' }], fast: true })) text += part
      return text
    }
    assert.equal(await read(), 'Bees pollinate [1].')
    stop = 'refusal'
    await assert.rejects(read(), (error: unknown) => error instanceof AiProviderError && error.message === REFUSAL_MESSAGE)
    await assert.rejects(
      chat.complete({ system: 's', prompt: 'p' }),
      (error: unknown) => error instanceof AiProviderError && error.status === 400 && !error.retryable && !error.message.includes('echo'),
    )
  })

  it('is chosen with CHAT_PROVIDER=anthropic, Claude Opus 5.5 unless another model is named', () => {
    process.env.CHAT_PROVIDER = 'anthropic'
    resetEnvCache()
    assert.throws(() => getChatBackend(), /CHAT_PROVIDER=anthropic requires ANTHROPIC_API_KEY/)
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    resetEnvCache()
    assert.deepEqual(getChatBackend(), { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-5-5' })
    assert.equal(getFastChatModel(), null)
    process.env.ANTHROPIC_CHAT_MODEL = 'claude-sonnet-5-5'
    process.env.ANTHROPIC_FAST_MODEL = 'claude-haiku-5-5'
    resetEnvCache()
    assert.equal(getChatBackend().model, 'claude-sonnet-5-5')
    assert.equal(getFastChatModel(), 'claude-haiku-5-5')
  })
})
