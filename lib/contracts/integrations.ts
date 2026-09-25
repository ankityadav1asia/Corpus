/** Chat-app bots (Slack, Microsoft Teams) that answer from a workspace. */
import { z } from 'zod'

import { id, secretText } from './fields'

export const INTEGRATION_PROVIDERS = ['slack', 'teams'] as const
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number]

/** Connect a Slack app or a Microsoft Teams (Azure Bot) to this workspace (admins). */
export const integrationCreateSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('slack'),
    name: z.string().trim().min(1).max(80),
    collectionId: id.nullable(),
    botToken: secretText(300).regex(/^xoxb-/, 'The bot token starts with xoxb-'),
    signingSecret: secretText(200),
  }),
  z.object({
    provider: z.literal('teams'),
    name: z.string().trim().min(1).max(80),
    collectionId: id.nullable(),
    appId: z.guid('The Microsoft App ID is a GUID'),
    appPassword: secretText(300),
    /** Directory (tenant) id of a single-tenant bot; empty for multi-tenant bots. */
    tenantId: z.guid().nullable().optional(),
  }),
])

export interface IntegrationSummary {
  id: string
  provider: IntegrationProvider
  name: string
  /** The notebook it answers from, or null for all notebooks (see allNotebooks). */
  collectionId: string | null
  allNotebooks: boolean
  /** Where the chat platform must send events (Slack Request URL / Azure Bot messaging endpoint). */
  endpoint: string
  /** Workspace / bot identity reported by the platform when it was connected. */
  account: string | null
  status: 'active' | 'error'
  lastError: string | null
  lastUsedAt: string | null
  createdAt: string
}
