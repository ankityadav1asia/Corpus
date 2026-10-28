import Anthropic from '@anthropic-ai/sdk'

import { AiProviderError, type AiProvider, type ChatTurn } from '@/server/ai/provider'
import { recordUsage } from '@/server/ai/usage'

/**
 * Claude (Anthropic Messages API) for answers and helper calls; embeddings stay with another
 * provider (combineProviders). Claude's current models always think and take no sampling settings,
 * so speed is set with effort: fast calls (standard answers, query planning, re-ranking, judging)
 * run at low effort, deep answers and reports at medium. The system prompt is cached.
 */

export interface AnthropicConfig {
  apiKey: string
  model: string
  /** A cheaper model for helper calls; null uses the chat model at low effort. */
  fastModel?: string | null
  /** Tests pass a client pointed at a fake server. */
  client?: Anthropic
}

const MAX_TOKENS = 16_000
/** Models that accept server-side refusal fallbacks in their "default" form. */
const FALLBACK_MODELS = /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-1)$/
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export const REFUSAL_MESSAGE = 'The model declined to answer this request.'

function toProviderError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error
  if (error instanceof Anthropic.APIUserAbortError) return new AiProviderError('Request aborted')
  if (error instanceof Anthropic.APIConnectionError) return new AiProviderError('Claude request failed (network)', undefined, true)
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    const retryAfter = Number(error.headers?.get('retry-after'))
    const status = error.status
    return new AiProviderError(`Claude request failed (${status})`, status, status === 429 || status >= 500, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined)
  }
  return new AiProviderError('Claude request failed', undefined, true)
}

function record(model: string, usage: Anthropic.Beta.BetaUsage) {
  // Cached prompt tokens are still prompt tokens (billed at a discount).
  const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
  return recordUsage({ model, kind: 'generate', inputTokens: input, outputTokens: usage.output_tokens, estimated: false })
}

function request(model: string, system: string, messages: Anthropic.Beta.BetaMessageParam[], fast: boolean) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
    messages,
    output_config: { effort: fast ? ('low' as const) : ('medium' as const) },
    // A declined request is answered by Anthropic's recommended fallback model in the same call.
    ...(FALLBACK_MODELS.test(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  }
}

const toMessages = (turns: readonly ChatTurn[]): Anthropic.Beta.BetaMessageParam[] => turns.map((turn) => ({ role: turn.role, content: turn.content }))

export function createAnthropicChat(config: AnthropicConfig): Pick<AiProvider, 'chatModel' | 'streamChat' | 'complete'> {
  const client = config.client ?? new Anthropic({ apiKey: config.apiKey })

  return {
    chatModel: config.model,

    async *streamChat({ system, turns, fast = false, signal }) {
      const stream = client.beta.messages.stream(request(config.model, system, toMessages(turns), fast), { signal })
      let final: Anthropic.Beta.BetaMessage
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) yield event.delta.text
        }
        final = await stream.finalMessage()
      } catch (error) {
        throw toProviderError(error)
      }
      await record(final.model, final.usage)
      if (final.stop_reason === 'refusal') throw new AiProviderError(REFUSAL_MESSAGE)
    },

    async complete({ system, prompt, fast = false, signal }) {
      const model = fast && config.fastModel ? config.fastModel : config.model
      let response: Anthropic.Beta.BetaMessage
      try {
        response = await client.beta.messages.create({ ...request(model, system, [{ role: 'user', content: prompt }], fast), stream: false }, { signal })
      } catch (error) {
        throw toProviderError(error)
      }
      await record(response.model, response.usage)
      if (response.stop_reason === 'refusal') throw new AiProviderError(REFUSAL_MESSAGE)
      return response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
    },
  }
}
