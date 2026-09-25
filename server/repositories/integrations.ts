import type { IntegrationProvider } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { toIso } from '@/server/repositories/sql'

export interface IntegrationRecord {
  id: string
  workspaceId: string
  provider: IntegrationProvider
  name: string
  /** The notebook it answers from; null with allNotebooks = false means that notebook was deleted. */
  collectionId: string | null
  allNotebooks: boolean
  /** Sealed JSON (server/security/secrets.ts). */
  credentials: string
  status: 'active' | 'error'
  lastError: string | null
  lastUsedAt: string | null
  createdAt: string
  createdBy: string | null
}

const COLUMNS = `id, workspace_id, provider, name, collection_id, all_notebooks, credentials, status, last_error, last_used_at, created_at, created_by`

function mapIntegration(row: Record<string, unknown>): IntegrationRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    provider: row.provider === 'teams' ? 'teams' : 'slack',
    name: String(row.name),
    collectionId: row.collection_id ? String(row.collection_id) : null,
    allNotebooks: row.all_notebooks === true,
    credentials: String(row.credentials),
    status: row.status === 'error' ? 'error' : 'active',
    lastError: row.last_error ? String(row.last_error) : null,
    lastUsedAt: row.last_used_at ? toIso(row.last_used_at) : null,
    createdAt: toIso(row.created_at),
    createdBy: row.created_by ? String(row.created_by) : null,
  }
}

/** Chat-app bots (Slack, Microsoft Teams) connected to a workspace. */
export function integrationsRepository(db: Db) {
  return {
    async create(input: {
      workspaceId: string
      createdBy: string
      provider: IntegrationProvider
      name: string
      collectionId: string | null
      credentials: string
    }): Promise<IntegrationRecord> {
      const [row] = await db.query(
        `INSERT INTO app.integrations (workspace_id, created_by, provider, name, collection_id, all_notebooks, credentials)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [input.workspaceId, input.createdBy, input.provider, input.name, input.collectionId, input.collectionId === null, input.credentials],
      )
      if (!row) throw new Error('Integration insert returned no row')
      return mapIntegration(row)
    },

    async list(workspaceId: string): Promise<IntegrationRecord[]> {
      const rows = await db.query(`SELECT ${COLUMNS} FROM app.integrations WHERE workspace_id = $1 ORDER BY created_at DESC`, [workspaceId])
      return rows.map(mapIntegration)
    },

    /** By id alone: webhooks identify the integration by the id in their URL, then prove it with its secret. */
    async byId(id: string): Promise<IntegrationRecord | null> {
      const [row] = await db.query(`SELECT ${COLUMNS} FROM app.integrations WHERE id = $1`, [id])
      return row ? mapIntegration(row) : null
    },

    async delete(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.integrations WHERE workspace_id = $1 AND id = $2 RETURNING id`, [workspaceId, id])
      return rows.length > 0
    },

    async markUsed(id: string): Promise<void> {
      await db.query(`UPDATE app.integrations SET last_used_at = now(), status = 'active', last_error = NULL WHERE id = $1`, [id])
    },

    async markError(id: string, message: string): Promise<void> {
      await db.query(`UPDATE app.integrations SET status = 'error', last_error = $2 WHERE id = $1`, [id, message.slice(0, 500)])
    },
  }
}
