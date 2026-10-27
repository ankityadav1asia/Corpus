/** Chat-app bots (Slack) that answer from a workspace. */
import { z } from 'zod'

import { id, secretText } from './fields'

export const INTEGRATION_PROVIDERS = ['slack'] as const
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number]

/** Connect a Slack app to this workspace (admins). */
export const integrationCreateSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('slack'),
    name: z.string().trim().min(1).max(80),
    collectionId: id.nullable(),
    botToken: secretText(300).regex(/^xoxb-/, 'The bot token starts with xoxb-'),
    signingSecret: secretText(200),
  }),
])

export interface IntegrationSummary {
  id: string
  provider: IntegrationProvider
  name: string
  /** The notebook it answers from, or null for all notebooks (see allNotebooks). */
  collectionId: string | null
  allNotebooks: boolean
  /** Where the chat platform must send events (the Slack Request URL). */
  endpoint: string
  /** Workspace / bot identity reported by the platform when it was connected. */
  account: string | null
  status: 'active' | 'error'
  lastError: string | null
  lastUsedAt: string | null
  createdAt: string
}
