import { createHmac } from 'node:crypto'

import { PermanentJobError } from '@/server/jobs/errors'
import { secretsEqual } from '@/server/security/compare'

/**
 * Slack bot over the Events API. Slack signs every request with the app's signing secret
 * (HMAC-SHA256 of `v0:{timestamp}:{raw body}`); requests older than five minutes are refused so a
 * captured request cannot be replayed. Replies go out with chat.postMessage in the same thread.
 */

const MAX_SKEW_SECONDS = 5 * 60
const API = 'https://slack.com/api'

export interface SlackCredentials {
  botToken: string
  signingSecret: string
}

export function verifySlackSignature(input: { signingSecret: string; timestamp: string | null; signature: string | null; body: string; now?: number }): boolean {
  const { timestamp, signature } = input
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !signature.startsWith('v0=')) return false
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000)
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false
  const expected = `v0=${createHmac('sha256', input.signingSecret).update(`v0:${timestamp}:${input.body}`).digest('hex')}`
  return secretsEqual(expected, signature)
}

export type SlackEnvelope =
  | { type: 'url_verification'; challenge: string }
  | { type: 'question'; eventId: string; teamId: string | null; channel: string; threadTs: string; user: string; text: string }
  | { type: 'ignore' }

/** Removes mentions (<@U123>), and turns Slack links (<https://…|label>) and entities into plain text. */
export function cleanSlackText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

const stringOr = <T>(value: unknown, fallback: T): string | T => (typeof value === 'string' ? value : fallback)

/** A person's message the bot answers: an @mention in a channel or a direct message. */
function askedInEvent(event: Record<string, unknown>): { text: string; channel: string; user: string } | null {
  if (event.bot_id || event.subtype) return null
  if (typeof event.text !== 'string' || typeof event.channel !== 'string' || typeof event.user !== 'string') return null
  const direct = event.type === 'message' && event.channel_type === 'im'
  if (event.type !== 'app_mention' && !direct) return null
  const text = cleanSlackText(event.text)
  return text ? { text, channel: event.channel, user: event.user } : null
}

/**
 * What an Events API request asks for: the URL check, a question (an @mention in a channel or a
 * direct message), or nothing (bot messages, edits, joins, other events).
 */
export function parseSlackEnvelope(payload: unknown): SlackEnvelope {
  if (!payload || typeof payload !== 'object') return { type: 'ignore' }
  const body = payload as Record<string, unknown>
  if (body.type === 'url_verification' && typeof body.challenge === 'string') return { type: 'url_verification', challenge: body.challenge.slice(0, 200) }
  if (body.type !== 'event_callback' || !body.event || typeof body.event !== 'object') return { type: 'ignore' }
  const event = body.event as Record<string, unknown>
  const asked = askedInEvent(event)
  if (!asked) return { type: 'ignore' }
  const ts = stringOr(event.ts, '')
  return {
    type: 'question',
    eventId: stringOr(body.event_id, ts),
    teamId: stringOr(body.team_id, null),
    channel: asked.channel,
    // Replies go in a thread: the existing one, or a new one under the question.
    threadTs: stringOr(event.thread_ts, ts),
    user: asked.user,
    text: asked.text,
  }
}

/**
 * Makes text inert for Slack: `<!channel>`, `<@U…>` or `<https://evil|Official>` in a model reply
 * (which a prompt-injected document can steer) would otherwise ping people or disguise links.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Model Markdown → Slack mrkdwn (bold, headings, bullets). The text is escaped first, and links
 * are written as "label (url)" so the real address is always visible.
 */
export function toSlackMrkdwn(markdown: string): string {
  return escapeSlackText(markdown)
    .replace(/```chart[\s\S]*?```/g, '_(chart available in Corpus)_')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
}

type Fetch = typeof fetch

async function slackCall<T extends { ok: boolean; error?: string }>(fetcher: Fetch, token: string, method: string, body: Record<string, unknown>): Promise<T> {
  let response: Response
  try {
    response = await fetcher(`${API}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error(`Slack ${method} could not be reached`)
  }
  if (response.status === 429 || response.status >= 500) throw new Error(`Slack ${method} failed (${response.status})`)
  const data = (await response.json().catch(() => ({ ok: false, error: 'invalid_response' }))) as T
  if (!data.ok) {
    const error = data.error ?? 'unknown_error'
    // Bad credentials or missing scopes cannot be fixed by retrying.
    if (/invalid_auth|not_authed|account_inactive|token_revoked|missing_scope|not_in_channel|channel_not_found/.test(error)) {
      throw new PermanentJobError(`Slack refused the request (${error}). Check the bot token, its scopes and that the bot is in the channel.`)
    }
    throw new Error(`Slack ${method} failed (${error})`)
  }
  return data
}

/** Checks a bot token and returns the Slack workspace and bot name it belongs to. */
export async function slackAuthTest(fetcher: Fetch, botToken: string): Promise<{ team: string; bot: string }> {
  const data = await slackCall<{ ok: boolean; error?: string; team?: string; user?: string }>(fetcher, botToken, 'auth.test', {})
  return { team: data.team ?? 'Slack', bot: data.user ?? 'bot' }
}

export async function postSlackReply(fetcher: Fetch, botToken: string, input: { channel: string; threadTs: string; text: string }): Promise<void> {
  await slackCall(fetcher, botToken, 'chat.postMessage', {
    channel: input.channel,
    thread_ts: input.threadTs,
    text: input.text.slice(0, 39_000),
    mrkdwn: true,
    unfurl_links: false,
  })
}
