/** Connected apps (Google Drive) and the sources synced from them. */
import { z } from 'zod'

import { LIMITS } from '@/lib/constants'

import { id } from './fields'

/** Earlier versions also connected Notion, GitHub and websites; their rows are hidden (server/repositories/connectors.ts). */
export const CONNECTOR_PROVIDERS = ['google_drive'] as const
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number]
export const CONNECTOR_KINDS = ['file', 'folder'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

export const connectorSourceCreateSchema = z.object({
  collectionId: id,
  provider: z.enum(CONNECTOR_PROVIDERS),
  connectionId: id,
  items: z
    .array(
      z.object({
        externalId: z.string().trim().min(1).max(LIMITS.urlChars),
        kind: z.enum(CONNECTOR_KINDS),
        name: z.string().trim().min(1).max(LIMITS.documentTitleChars),
      }),
    )
    .min(1)
    .max(50),
  autoSync: z.boolean().default(true),
  syncIntervalHours: z.number().int().min(1).max(720).default(24),
})
export const connectorSourceUpdateSchema = z
  .object({ autoSync: z.boolean().optional(), syncIntervalHours: z.number().int().min(1).max(720).optional() })
  .refine((value) => value.autoSync !== undefined || value.syncIntervalHours !== undefined, 'Nothing to update')

export interface ConnectionSummary {
  id: string
  provider: ConnectorProvider
  accountLabel: string
  status: 'active' | 'error'
  error: string | null
  /** Only the owner can browse and import through a connection. */
  mine: boolean
  ownerEmail: string | null
  createdAt: string
}

export interface ConnectorBrowseItem {
  id: string
  name: string
  kind: ConnectorKind
  /** Can be opened to list its contents. */
  container: boolean
  /** Can be added to a notebook. */
  importable: boolean
  mimeType: string | null
  modifiedAt: string | null
  size: number | null
  url: string | null
}

export interface ConnectorBrowseResult {
  items: ConnectorBrowseItem[]
  nextCursor: string | null
}

export interface ConnectorSourceSummary {
  id: string
  provider: ConnectorProvider
  kind: ConnectorKind
  name: string
  url: string | null
  collectionId: string
  connectionId: string | null
  autoSync: boolean
  syncIntervalHours: number
  status: 'queued' | 'syncing' | 'idle' | 'error'
  progress: string | null
  itemCount: number
  lastError: string | null
  lastSyncedAt: string | null
  nextSyncAt: string | null
  createdByEmail: string | null
  createdAt: string
}

export interface ConnectorsOverview {
  providers: Array<{ id: ConnectorProvider; available: boolean; reason: string | null }>
  connections: ConnectionSummary[]
  sources: ConnectorSourceSummary[]
}
