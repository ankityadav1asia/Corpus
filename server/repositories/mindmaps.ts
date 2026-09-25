import type { JobStatus, MindMapDetail, MindMapNode, MindMapSummary, StudioSource } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { asJsonArray, asJsonObject, asUuidArray, toIso, toNullableNumber } from '@/server/repositories/sql'

export interface MindMapJob {
  id: string
  workspaceId: string
  createdBy: string | null
  title: string
  focus: string | null
  collectionIds: string[]
  documentIds: string[]
}

const SUMMARY_COLUMNS = `m.id, m.title, m.focus, m.status, m.progress, m.node_count, m.created_at, m.completed_at, u.email AS created_by_email`

function mapSummary(row: Record<string, unknown>): MindMapSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    focus: row.focus ? String(row.focus) : null,
    status: row.status as JobStatus,
    progress: row.progress ? String(row.progress) : null,
    nodeCount: toNullableNumber(row.node_count),
    createdByEmail: row.created_by_email ? String(row.created_by_email) : null,
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
  }
}

export function mindMapsRepository(db: Db) {
  return {
    async create(input: Omit<MindMapJob, 'id'>): Promise<MindMapSummary> {
      const [row] = await db.query(
        `WITH m AS (
           INSERT INTO app.mind_maps (workspace_id, created_by, title, focus, collection_ids, document_ids)
           VALUES ($1, $2, $3, $4, $5::uuid[], $6::uuid[])
           RETURNING *
         )
         SELECT ${SUMMARY_COLUMNS} FROM m LEFT JOIN app.users u ON u.id = m.created_by`,
        [input.workspaceId, input.createdBy, input.title, input.focus, input.collectionIds, input.documentIds],
      )
      if (!row) throw new Error('Mind map insert returned no row')
      return mapSummary(row)
    },

    async list(workspaceId: string, limit = 100): Promise<MindMapSummary[]> {
      const rows = await db.query(
        `SELECT ${SUMMARY_COLUMNS} FROM app.mind_maps m LEFT JOIN app.users u ON u.id = m.created_by
         WHERE m.workspace_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
        [workspaceId, limit],
      )
      return rows.map(mapSummary)
    },

    async count(workspaceId: string): Promise<number> {
      const [row] = await db.query(`SELECT count(*)::int AS n FROM app.mind_maps WHERE workspace_id = $1`, [workspaceId])
      return Number(row?.n ?? 0)
    },

    async get(workspaceId: string, id: string): Promise<(MindMapDetail & { createdBy: string | null }) | null> {
      const [row] = await db.query(
        `SELECT ${SUMMARY_COLUMNS}, m.collection_ids, m.document_ids, m.root, m.sources, m.model, m.error, m.created_by
         FROM app.mind_maps m LEFT JOIN app.users u ON u.id = m.created_by
         WHERE m.id = $1 AND m.workspace_id = $2`,
        [id, workspaceId],
      )
      if (!row) return null
      return {
        ...mapSummary(row),
        collectionIds: asUuidArray(row.collection_ids),
        documentIds: asUuidArray(row.document_ids),
        root: asJsonObject<MindMapNode>(row.root),
        sources: asJsonArray<StudioSource>(row.sources),
        model: row.model ? String(row.model) : null,
        error: row.error ? String(row.error) : null,
        createdBy: row.created_by ? String(row.created_by) : null,
      }
    },

    /** What the generation job needs; null when gone or already finished. */
    async forJob(id: string): Promise<MindMapJob | null> {
      const [row] = await db.query(
        `SELECT id, workspace_id, created_by, title, focus, collection_ids, document_ids FROM app.mind_maps WHERE id = $1 AND status IN ('queued', 'running')`,
        [id],
      )
      if (!row) return null
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        createdBy: row.created_by ? String(row.created_by) : null,
        title: String(row.title),
        focus: row.focus ? String(row.focus) : null,
        collectionIds: asUuidArray(row.collection_ids),
        documentIds: asUuidArray(row.document_ids),
      }
    },

    async setProgress(id: string, status: JobStatus, progress: string | null): Promise<void> {
      await db.query(`UPDATE app.mind_maps SET status = $2, progress = $3 WHERE id = $1 AND status IN ('queued', 'running')`, [id, status, progress])
    },

    async complete(id: string, result: { title: string; root: MindMapNode; nodeCount: number; sources: StudioSource[]; model: string }): Promise<void> {
      await db.query(
        `UPDATE app.mind_maps SET status = 'completed', progress = NULL, error = NULL, title = $2, root = $3::jsonb, node_count = $4, sources = $5::jsonb, model = $6, completed_at = now()
         WHERE id = $1`,
        [id, result.title, JSON.stringify(result.root), result.nodeCount, JSON.stringify(result.sources), result.model],
      )
    },

    async fail(id: string, error: string): Promise<void> {
      await db.query(`UPDATE app.mind_maps SET status = 'failed', progress = NULL, error = left($2, 500), completed_at = now() WHERE id = $1`, [id, error])
    },

    async delete(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.mind_maps WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId])
      return rows.length > 0
    },
  }
}
