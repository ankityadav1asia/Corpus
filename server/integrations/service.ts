import { z } from 'zod'

import { INSUFFICIENT_CONTEXT_MESSAGE } from '@/lib/constants'
import type { IntegrationSummary, integrationCreateSchema } from '@/lib/contracts'
import type { AiProvider } from '@/server/ai/provider'
import { requireWorkspacePermission, type WorkspaceAccess } from '@/server/auth/access'
import { Errors } from '@/server/http/errors'
import { escapeSlackText, postSlackReply, slackAuthTest, toSlackMrkdwn, type SlackCredentials } from '@/server/integrations/slack'
import { getBotToken, replyInTeams, sendTeamsTyping, type TeamsCredentials } from '@/server/integrations/teams'
import { PermanentJobError } from '@/server/jobs/errors'
import { log } from '@/server/logger'
import { buildUserPrompt, normalizeTurns, systemPrompt } from '@/server/rag/prompt'
import type { Reranker } from '@/server/rag/rerank'
import { retrieve, toCitations } from '@/server/rag/retrieval'
import type { Repositories } from '@/server/repositories'
import type { IntegrationRecord } from '@/server/repositories/integrations'
import { openSecret, sealSecret } from '@/server/security/secrets'
import type { SecretKeys } from '@/server/security/keys'

type Fetch = typeof fetch

type StoredCredentials = (({ provider: 'slack' } & SlackCredentials) | ({ provider: 'teams' } & TeamsCredentials)) & { account: string }

export function integrationEndpoint(origin: string, record: Pick<IntegrationRecord, 'id' | 'provider'>): string {
  return record.provider === 'slack' ? `${origin}/api/integrations/slack/${record.id}/events` : `${origin}/api/integrations/teams/${record.id}/messages`
}

export async function readCredentials(record: IntegrationRecord, secret: SecretKeys): Promise<StoredCredentials> {
  return JSON.parse(await openSecret(record.credentials, secret)) as StoredCredentials
}

const NOTEBOOK_DELETED = 'The notebook this bot answered from was deleted, so it no longer answers. Connect it again and choose a notebook.'

/** Limited to one notebook that no longer exists: it must not fall back to every notebook. */
const lostNotebook = (record: Pick<IntegrationRecord, 'allNotebooks' | 'collectionId'>) => !record.allNotebooks && record.collectionId === null

async function toSummary(record: IntegrationRecord, origin: string, secret: SecretKeys): Promise<IntegrationSummary> {
  let account: string | null = null
  try {
    account = (await readCredentials(record, secret)).account
  } catch {
    account = null
  }
  const problem = account === null ? 'Credentials can no longer be read (AUTH_SECRET changed). Connect it again.' : lostNotebook(record) ? NOTEBOOK_DELETED : null
  return {
    id: record.id,
    provider: record.provider,
    name: record.name,
    collectionId: record.collectionId,
    allNotebooks: record.allNotebooks,
    endpoint: integrationEndpoint(origin, record),
    account,
    status: problem ? 'error' : record.status,
    lastError: problem ?? record.lastError,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
  }
}

interface ManageDeps {
  repos: Pick<Repositories, 'integrations' | 'collections'>
  fetch: Fetch
  secret: SecretKeys
}

/** Connects a Slack app or Teams bot after checking its credentials with the platform (admins). */
export async function createIntegration(deps: ManageDeps, access: WorkspaceAccess, input: z.output<typeof integrationCreateSchema>, origin: string): Promise<IntegrationSummary> {
  requireWorkspacePermission(access, 'integrations.manage')
  if (input.collectionId && !(await deps.repos.collections.get(access.workspaceId, input.collectionId, access.userId))) throw Errors.notFound('Notebook')

  let credentials: StoredCredentials
  try {
    if (input.provider === 'slack') {
      const identity = await slackAuthTest(deps.fetch, input.botToken)
      credentials = { provider: 'slack', botToken: input.botToken, signingSecret: input.signingSecret, account: `${identity.team} · @${identity.bot}` }
    } else {
      const tenantId = input.tenantId ?? null
      await getBotToken(deps.fetch, { appId: input.appId, appPassword: input.appPassword, tenantId })
      credentials = {
        provider: 'teams',
        appId: input.appId,
        appPassword: input.appPassword,
        tenantId,
        account: `Azure Bot ${input.appId.slice(0, 8)}…${tenantId ? ' (single tenant)' : ''}`,
      }
    }
  } catch (error) {
    const reason = error instanceof PermanentJobError ? error.message : 'the platform could not be reached'
    throw Errors.badRequest(`Could not connect: ${reason}`)
  }

  const record = await deps.repos.integrations.create({
    workspaceId: access.workspaceId,
    createdBy: access.userId,
    provider: input.provider,
    name: input.name,
    collectionId: input.collectionId,
    credentials: await sealSecret(JSON.stringify(credentials), deps.secret),
  })
  return toSummary(record, origin, deps.secret)
}

export async function listIntegrations(deps: Pick<ManageDeps, 'repos' | 'secret'>, access: WorkspaceAccess, origin: string): Promise<IntegrationSummary[]> {
  requireWorkspacePermission(access, 'integrations.manage')
  return Promise.all((await deps.repos.integrations.list(access.workspaceId)).map((record) => toSummary(record, origin, deps.secret)))
}

export async function deleteIntegration(deps: Pick<ManageDeps, 'repos'>, access: WorkspaceAccess, id: string): Promise<void> {
  requireWorkspacePermission(access, 'integrations.manage')
  if (!(await deps.repos.integrations.delete(access.workspaceId, id))) throw Errors.notFound('Integration')
}

/* ── Answering ─────────────────────────────────────────────────────────────── */

export const botMessagePayload = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('slack'), integrationId: z.guid(), question: z.string().min(1).max(4_000), channel: z.string().max(40), threadTs: z.string().max(40) }),
  z.object({
    provider: z.literal('teams'),
    integrationId: z.guid(),
    question: z.string().min(1).max(4_000),
    serviceUrl: z.string().max(500),
    conversationId: z.string().max(500),
    activityId: z.string().max(200),
  }),
])
export type BotMessagePayload = z.infer<typeof botMessagePayload>

export interface AnswerDeps {
  repos: Pick<Repositories, 'workspaces' | 'documents' | 'integrations'>
  ai: AiProvider
  reranker: Reranker | null
  fetch: Fetch
  secret: SecretKeys
}

const BOT_NOTE = '\n- You are replying in a team chat app: keep it short (a few sentences or bullets). Do not add charts.'

/** One question, answered from the integration's workspace (and notebook) with the normal pipeline. */
export async function answerFromWorkspace(
  deps: Omit<AnswerDeps, 'fetch' | 'secret' | 'repos'> & { repos: Pick<Repositories, 'workspaces' | 'documents'> },
  scope: { workspaceId: string; collectionId: string | null },
  question: string,
) {
  const settings = await deps.repos.workspaces.settings(scope.workspaceId)
  const result = await retrieve(deps, scope, { question, mode: 'standard', history: [], settings })
  if (!result.guardrail.pass) return { answer: INSUFFICIENT_CONTEXT_MESSAGE, citations: [] }
  let answer = ''
  const turns = normalizeTurns([{ role: 'user', content: buildUserPrompt(question, result.hits) }])
  for await (const text of deps.ai.streamChat({ system: systemPrompt('standard') + BOT_NOTE, turns, fast: true })) answer += text
  return { answer: answer.trim() || INSUFFICIENT_CONTEXT_MESSAGE, citations: toCitations(result.hits) }
}

/** The reply text: the answer, then its numbered sources (web links kept). */
export function formatBotReply(answer: string, citations: ReadonlyArray<{ index: number; title: string; source: string }>, style: 'slack' | 'markdown'): string {
  const body = style === 'slack' ? toSlackMrkdwn(answer) : answer
  if (citations.length === 0) return body
  const lines = citations.map((citation) => {
    const link = /^https?:\/\//.test(citation.source) ? citation.source : null
    if (style === 'slack') return `[${citation.index}] ${link ? `<${link}|${escapeSlackText(citation.title).replace(/\|/g, ' ')}>` : escapeSlackText(citation.title)}`
    return `[${citation.index}] ${link ? `[${citation.title}](${link})` : citation.title}`
  })
  return `${body}\n\n${style === 'slack' ? '*Sources*' : '**Sources**'}\n${lines.join('\n')}`
}

/** Background job: answer a chat-app question and post the reply where it was asked. */
export async function answerBotMessage(deps: AnswerDeps, payload: BotMessagePayload): Promise<void> {
  const integration = await deps.repos.integrations.byId(payload.integrationId)
  if (!integration || integration.provider !== payload.provider) return // removed meanwhile
  const credentials = await readCredentials(integration, deps.secret).catch(() => {
    throw new PermanentJobError('The chat app credentials can no longer be read.')
  })

  let teamsToken: string | null = null
  if (payload.provider === 'teams' && credentials.provider === 'teams') {
    teamsToken = await getBotToken(deps.fetch, credentials)
    await sendTeamsTyping(deps.fetch, teamsToken, payload).catch(() => undefined)
  }

  let reply: string
  if (lostNotebook(integration)) {
    reply = 'This bot is not connected to a notebook any more. Ask a workspace admin to connect it again.'
    await deps.repos.integrations.markError(integration.id, NOTEBOOK_DELETED)
  } else {
    try {
      const { answer, citations } = await answerFromWorkspace(deps, { workspaceId: integration.workspaceId, collectionId: integration.collectionId }, payload.question)
      reply = formatBotReply(answer, citations, payload.provider === 'slack' ? 'slack' : 'markdown')
    } catch (error) {
      log.warn('Bot answer failed', { integrationId: integration.id, error: String(error) })
      reply = 'Sorry — I could not answer that right now. Please try again in a minute.'
    }
  }

  try {
    if (payload.provider === 'slack' && credentials.provider === 'slack') {
      await postSlackReply(deps.fetch, credentials.botToken, { channel: payload.channel, threadTs: payload.threadTs, text: reply })
    } else if (payload.provider === 'teams' && teamsToken) {
      await replyInTeams(deps.fetch, teamsToken, { serviceUrl: payload.serviceUrl, conversationId: payload.conversationId, id: payload.activityId }, reply)
    }
    if (!lostNotebook(integration)) await deps.repos.integrations.markUsed(integration.id)
  } catch (error) {
    if (error instanceof PermanentJobError) await deps.repos.integrations.markError(integration.id, error.message)
    throw error
  }
}
