import type { UsageEntry } from '@/server/ai/usage'
import type { Db } from '@/server/db/client'

/** Who a background job works for, found from its payload (jobs only store ids). */
const JOB_OWNER_SQL: Record<string, { key: string; sql: string }> = {
  ingest_document: { key: 'documentId', sql: `SELECT workspace_id, created_by FROM app.documents WHERE id = $1` },
  read_media: { key: 'documentId', sql: `SELECT workspace_id, created_by FROM app.documents WHERE id = $1` },
  generate_report: { key: 'reportId', sql: `SELECT workspace_id, created_by FROM app.reports WHERE id = $1` },
  sync_connector: { key: 'sourceId', sql: `SELECT workspace_id, created_by FROM app.connector_sources WHERE id = $1` },
  evaluate_answer: {
    key: 'messageId',
    sql: `SELECT c.workspace_id, c.owner_id AS created_by FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id WHERE m.id = $1`,
  },
  reembed_workspace: { key: 'workspaceId', sql: `SELECT id AS workspace_id, NULL AS created_by FROM app.workspaces WHERE id = $1` },
}

export function usageRepository(db: Db) {
  return {
    async record(entry: UsageEntry): Promise<void> {
      await db.query(
        `INSERT INTO app.ai_usage (workspace_id, user_id, feature, model, kind, input_tokens, output_tokens, estimated)
         VALUES ($1, $2, left($3, 60), left($4, 120), $5, $6, $7, $8)`,
        [entry.workspaceId, entry.userId, entry.feature, entry.model, entry.kind, entry.inputTokens, entry.outputTokens, entry.estimated],
      )
    },

    /** The workspace and member a job's model calls are billed to; nulls when the job's item is gone. */
    async jobOwner(type: string, payload: unknown): Promise<{ workspaceId: string | null; userId: string | null }> {
      const lookup = JOB_OWNER_SQL[type]
      const id = lookup && payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[lookup.key] : undefined
      if (!lookup || typeof id !== 'string') return { workspaceId: null, userId: null }
      const [row] = await db.query(lookup.sql, [id])
      return { workspaceId: row?.workspace_id ? String(row.workspace_id) : null, userId: row?.created_by ? String(row.created_by) : null }
    },

    /** Usage rows are kept for about a year; the cron endpoint drops older ones. */
    async purgeOlderThan(days: number): Promise<number> {
      const rows = await db.query(`DELETE FROM app.ai_usage WHERE created_at < now() - make_interval(days => $1::int) RETURNING id`, [days])
      return rows.length
    },
  }
}
