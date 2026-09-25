/** Connected apps (Google Drive, Notion, GitHub, websites) and the sources synced from them. */
import { z } from 'zod'

import { LIMITS } from '@/lib/constants'

import { id } from './fields'

export const CONNECTOR_PROVIDERS = ['google_drive', 'notion', 'github', 'website'] as const
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number]
export const CONNECTOR_KINDS = ['file', 'folder', 'page', 'database', 'repository', 'site'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/** Token-based connections (Google Drive connects with OAuth instead). */
export const connectionCreateSchema = z.object({
  provider: z.enum(['notion', 'github']),
  /** Notion: an internal integration secret. GitHub: a personal access token (empty = public repositories only). */
  token: z.string().trim().max(500).default(''),
})

export const connectorSourceCreateSchema = z.object({
  collectionId: id,
  provider: z.enum(CONNECTOR_PROVIDERS),
  /** null for websites (no account needed). */
  connectionId: id.nullable().default(null),
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
  options: z
    .object({
      /** GitHub: only files under this folder. Website: only pages under this path. */
      path: z.string().trim().max(200).optional(),
      /** Website: pages to read per sync. */
      maxPages: z.number().int().min(1).max(100).optional(),
    })
    .default({}),
})
export const connectorSourceUpdateSchema = z
  .object({ autoSync: z.boolean().optional(), syncIntervalHours: z.number().int().min(1).max(720).optional() })
  .refine((value) => value.autoSync !== undefined || value.syncIntervalHours !== undefined, 'Nothing to update')

export interface ConnectionSummary {
  id: string
  provider: Exclude<ConnectorProvider, 'website'>
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
