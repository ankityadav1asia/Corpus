import type { ConnectionSummary, ConnectorKind, ConnectorProvider, ConnectorSourceSummary } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { asJsonObject, toIso, toNumber } from '@/server/repositories/sql'

export interface ConnectionRecord {
  id: string
  workspaceId: string
  userId: string
  provider: Exclude<ConnectorProvider, 'website'>
  accountLabel: string
  /** Sealed (encrypted) credentials — see server/security/secrets.ts. */
  credentials: string
  status: 'active' | 'error'
}

export interface SyncState {
  items: Array<{ externalId: string; version: string | null; title: string; url: string | null; meta?: Record<string, string> }>
  index: number
  changed: number
  failed: number
  errors: string[]
}

export interface SourceRecord {
  id: string
  workspaceId: string
  collectionId: string
  connectionId: string | null
  createdBy: string | null
  provider: ConnectorProvider
  kind: ConnectorKind
  externalId: string
  name: string
  url: string | null
  options: { path?: string; maxPages?: number }
  syncIntervalHours: number
  syncState: SyncState | null
}

const SOURCE_COLUMNS = `s.id, s.provider, s.kind, s.name, s.url, s.collection_id, s.connection_id, s.auto_sync, s.sync_interval_hours, s.status, s.progress,
  s.item_count, s.last_error, s.last_synced_at, s.next_sync_at, s.created_at, u.email AS created_by_email`

function mapSource(row: Record<string, unknown>): ConnectorSourceSummary {
  return {
    id: String(row.id),
    provider: row.provider as ConnectorProvider,
    kind: row.kind as ConnectorKind,
    name: String(row.name),
    url: row.url ? String(row.url) : null,
    collectionId: String(row.collection_id),
    connectionId: row.connection_id ? String(row.connection_id) : null,
    autoSync: Boolean(row.auto_sync),
    syncIntervalHours: toNumber(row.sync_interval_hours),
    status: row.status as ConnectorSourceSummary['status'],
    progress: row.progress ? String(row.progress) : null,
    itemCount: toNumber(row.item_count),
    lastError: row.last_error ? String(row.last_error) : null,
    lastSyncedAt: row.last_synced_at ? toIso(row.last_synced_at) : null,
    nextSyncAt: row.next_sync_at ? toIso(row.next_sync_at) : null,
    createdByEmail: row.created_by_email ? String(row.created_by_email) : null,
    createdAt: toIso(row.created_at),
  }
}

function mapConnection(row: Record<string, unknown>, viewerId: string): ConnectionSummary {
  return {
    id: String(row.id),
    provider: row.provider as ConnectionSummary['provider'],
    accountLabel: String(row.account_label),
    status: row.status === 'error' ? 'error' : 'active',
    error: row.error ? String(row.error) : null,
    mine: String(row.user_id) === viewerId,
    ownerEmail: row.owner_email ? String(row.owner_email) : null,
    createdAt: toIso(row.created_at),
  }
}

export function connectorsRepository(db: Db) {
  return {
    /** Connecting the same account again refreshes its credentials. */
    async saveConnection(input: {
      workspaceId: string
      userId: string
      provider: ConnectionRecord['provider']
      accountLabel: string
      credentials: string
    }): Promise<ConnectionSummary> {
      const [row] = await db.query(
        `WITH saved AS (
           INSERT INTO app.connections (workspace_id, user_id, provider, account_label, credentials)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, user_id, provider, account_label)
           DO UPDATE SET credentials = excluded.credentials, status = 'active', error = NULL, updated_at = now()
           RETURNING *
         )
         SELECT saved.*, u.email AS owner_email FROM saved JOIN app.users u ON u.id = saved.user_id`,
        [input.workspaceId, input.userId, input.provider, input.accountLabel.slice(0, 200), input.credentials],
      )
      if (!row) throw new Error('Connection insert returned no row')
      return mapConnection(row, input.userId)
    },

    /** The caller's own connections; admins also see everyone else's (to remove them). */
    async listConnections(workspaceId: string, viewerId: string, includeOthers: boolean): Promise<ConnectionSummary[]> {
      const rows = await db.query(
        `SELECT c.*, u.email AS owner_email FROM app.connections c JOIN app.users u ON u.id = c.user_id
         WHERE c.workspace_id = $1 AND (c.user_id = $2 OR $3)
         ORDER BY c.created_at DESC`,
        [workspaceId, viewerId, includeOthers],
      )
      return rows.map((row) => mapConnection(row, viewerId))
    },

    async getConnection(workspaceId: string, id: string): Promise<ConnectionRecord | null> {
      const [row] = await db.query(`SELECT * FROM app.connections WHERE id = $1 AND workspace_id = $2`, [id, workspaceId])
      if (!row) return null
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        userId: String(row.user_id),
        provider: row.provider as ConnectionRecord['provider'],
        accountLabel: String(row.account_label),
        credentials: String(row.credentials),
        status: row.status === 'error' ? 'error' : 'active',
      }
    },

    async updateCredentials(id: string, credentials: string): Promise<void> {
      await db.query(`UPDATE app.connections SET credentials = $2, updated_at = now() WHERE id = $1`, [id, credentials])
    },

    async setConnectionStatus(id: string, status: 'active' | 'error', error: string | null): Promise<void> {
      await db.query(`UPDATE app.connections SET status = $2, error = left($3, 500), updated_at = now() WHERE id = $1`, [id, status, error])
    },

    async deleteConnection(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.connections WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId])
      return rows.length > 0
    },

    /** Adding the same item to the same notebook again updates it and queues a sync. */
    async saveSource(input: {
      workspaceId: string
      collectionId: string
      connectionId: string | null
      createdBy: string
      provider: ConnectorProvider
      kind: ConnectorKind
      externalId: string
      name: string
      url: string | null
      options: SourceRecord['options']
      autoSync: boolean
      syncIntervalHours: number
    }): Promise<ConnectorSourceSummary> {
      const [row] = await db.query(
        `WITH saved AS (
           INSERT INTO app.connector_sources (workspace_id, collection_id, connection_id, created_by, provider, kind, external_id, name, url, options, auto_sync, sync_interval_hours)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
           ON CONFLICT (collection_id, provider, external_id)
           DO UPDATE SET name = excluded.name, url = excluded.url, options = excluded.options, connection_id = excluded.connection_id,
                         auto_sync = excluded.auto_sync, sync_interval_hours = excluded.sync_interval_hours, status = 'queued', last_error = NULL
           RETURNING *
         )
         SELECT ${SOURCE_COLUMNS} FROM saved s LEFT JOIN app.users u ON u.id = s.created_by`,
        [
          input.workspaceId,
          input.collectionId,
          input.connectionId,
          input.createdBy,
          input.provider,
          input.kind,
          input.externalId,
          input.name.slice(0, 200),
          input.url,
          JSON.stringify(input.options),
          input.autoSync,
          input.syncIntervalHours,
        ],
      )
      if (!row) throw new Error('Source insert returned no row')
      return mapSource(row)
    },

    async listSources(workspaceId: string): Promise<ConnectorSourceSummary[]> {
      const rows = await db.query(
        `SELECT ${SOURCE_COLUMNS} FROM app.connector_sources s LEFT JOIN app.users u ON u.id = s.created_by
         WHERE s.workspace_id = $1 ORDER BY s.created_at DESC LIMIT 500`,
        [workspaceId],
      )
      return rows.map(mapSource)
    },

    async getSource(workspaceId: string, id: string): Promise<ConnectorSourceSummary | null> {
      const [row] = await db.query(`SELECT ${SOURCE_COLUMNS} FROM app.connector_sources s LEFT JOIN app.users u ON u.id = s.created_by WHERE s.id = $1 AND s.workspace_id = $2`, [
        id,
        workspaceId,
      ])
      return row ? mapSource(row) : null
    },

    /** What the sync job needs. */
    async sourceForSync(id: string): Promise<SourceRecord | null> {
      const [row] = await db.query(`SELECT * FROM app.connector_sources WHERE id = $1`, [id])
      if (!row) return null
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        collectionId: String(row.collection_id),
        connectionId: row.connection_id ? String(row.connection_id) : null,
        createdBy: row.created_by ? String(row.created_by) : null,
        provider: row.provider as ConnectorProvider,
        kind: row.kind as ConnectorKind,
        externalId: String(row.external_id),
        name: String(row.name),
        url: row.url ? String(row.url) : null,
        options: asJsonObject<SourceRecord['options']>(row.options) ?? {},
        syncIntervalHours: toNumber(row.sync_interval_hours, 24),
        syncState: asJsonObject<SyncState>(row.sync_state),
      }
    },

    async setSourceStatus(id: string, status: ConnectorSourceSummary['status'], progress: string | null): Promise<void> {
      await db.query(`UPDATE app.connector_sources SET status = $2, progress = $3 WHERE id = $1`, [id, status, progress])
    },

    async saveSyncState(id: string, state: SyncState | null): Promise<void> {
      await db.query(`UPDATE app.connector_sources SET sync_state = $2::jsonb WHERE id = $1`, [id, state ? JSON.stringify(state) : null])
    },

    async finishSync(id: string, result: { status: 'idle' | 'error'; itemCount: number; error: string | null }): Promise<void> {
      await db.query(
        `UPDATE app.connector_sources SET status = $2, progress = NULL, sync_state = NULL, item_count = $3, last_error = left($4, 1000),
           last_synced_at = now(), next_sync_at = now() + make_interval(hours => sync_interval_hours)
         WHERE id = $1`,
        [id, result.status, result.itemCount, result.error],
      )
    },

    async updateSource(workspaceId: string, id: string, changes: { autoSync?: boolean; syncIntervalHours?: number }): Promise<ConnectorSourceSummary | null> {
      const [row] = await db.query(
        `WITH updated AS (
           UPDATE app.connector_sources SET
             auto_sync = coalesce($3, auto_sync),
             sync_interval_hours = coalesce($4, sync_interval_hours),
             next_sync_at = CASE WHEN last_synced_at IS NULL THEN next_sync_at ELSE last_synced_at + make_interval(hours => coalesce($4, sync_interval_hours)) END
           WHERE id = $1 AND workspace_id = $2
           RETURNING *
         )
         SELECT ${SOURCE_COLUMNS} FROM updated s LEFT JOIN app.users u ON u.id = s.created_by`,
        [id, workspaceId, changes.autoSync ?? null, changes.syncIntervalHours ?? null],
      )
      return row ? mapSource(row) : null
    },

    /** Removes the source; its documents stay in the notebook unless `withDocuments`. */
    async deleteSource(workspaceId: string, id: string, withDocuments: boolean): Promise<boolean> {
      if (withDocuments) await db.query(`DELETE FROM app.documents WHERE workspace_id = $1 AND connector_source_id = $2`, [workspaceId, id])
      const rows = await db.query(`DELETE FROM app.connector_sources WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId])
      return rows.length > 0
    },

    /** Latest document per external item of a source (for change detection). */
    async syncedDocuments(sourceId: string): Promise<Array<{ id: string; externalId: string; version: string | null; status: string }>> {
      const rows = await db.query(
        `SELECT DISTINCT ON (external_id) id, external_id, external_version, status FROM app.documents
         WHERE connector_source_id = $1 AND external_id IS NOT NULL
         ORDER BY external_id, created_at DESC`,
        [sourceId],
      )
      return rows.map((row) => ({
        id: String(row.id),
        externalId: String(row.external_id),
        version: row.external_version ? String(row.external_version) : null,
        status: String(row.status),
      }))
    },

    /** Items that disappeared upstream. */
    async deleteMissingDocuments(sourceId: string, keepExternalIds: readonly string[]): Promise<number> {
      const rows = await db.query(`DELETE FROM app.documents WHERE connector_source_id = $1 AND NOT (external_id = ANY($2::text[])) RETURNING id`, [sourceId, [...keepExternalIds]])
      return rows.length
    },

    /** Sources whose scheduled sync is due, marked queued atomically (so they are queued once). */
    async claimDueSources(limit: number): Promise<string[]> {
      const rows = await db.query(
        `UPDATE app.connector_sources SET status = 'queued'
         WHERE id IN (
           SELECT id FROM app.connector_sources
           WHERE auto_sync AND next_sync_at IS NOT NULL AND next_sync_at <= now() AND status IN ('idle', 'error')
           ORDER BY next_sync_at LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id`,
        [limit],
      )
      return rows.map((row) => String(row.id))
    },
  }
}
