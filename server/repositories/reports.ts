import type { ReportTemplate } from '@/lib/constants'
import type { JobStatus, ReportDetail, ReportSummary, SlideOutline } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { asJsonArray, toIso } from '@/server/repositories/sql'

export interface ReportJobInput {
  id: string
  workspaceId: string
  createdBy: string | null
  template: ReportTemplate
  format: 'markdown' | 'json'
  title: string
  instructions: string | null
  collectionIds: string[]
  documentIds: string[]
}

const SUMMARY_COLUMNS = `r.id, r.title, r.template, r.format, r.status, r.progress, r.created_at, r.completed_at, u.email AS created_by_email`

function asUuidArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.startsWith('{')) return value.slice(1, -1).split(',').filter(Boolean)
  return []
}

function mapSummary(row: Record<string, unknown>): ReportSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    template: row.template as ReportTemplate,
    format: row.format === 'json' ? 'json' : 'markdown',
    status: row.status as JobStatus,
    progress: row.progress ? String(row.progress) : null,
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    createdByEmail: row.created_by_email ? String(row.created_by_email) : null,
  }
}

export function reportsRepository(db: Db) {
  return {
    async create(input: Omit<ReportJobInput, 'id'>): Promise<ReportSummary> {
      const [row] = await db.query(
        `WITH r AS (
           INSERT INTO app.reports (workspace_id, created_by, template, format, title, instructions, collection_ids, document_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8::uuid[])
           RETURNING *
         )
         SELECT ${SUMMARY_COLUMNS} FROM r LEFT JOIN app.users u ON u.id = r.created_by`,
        [input.workspaceId, input.createdBy, input.template, input.format, input.title, input.instructions, input.collectionIds, input.documentIds],
      )
      if (!row) throw new Error('Report insert returned no row')
      return mapSummary(row)
    },

    async list(workspaceId: string, limit = 50): Promise<ReportSummary[]> {
      const rows = await db.query(
        `SELECT ${SUMMARY_COLUMNS} FROM app.reports r LEFT JOIN app.users u ON u.id = r.created_by
         WHERE r.workspace_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
        [workspaceId, limit],
      )
      return rows.map(mapSummary)
    },

    async get(workspaceId: string, id: string): Promise<(ReportDetail & { createdBy: string | null }) | null> {
      const [row] = await db.query(
        `SELECT ${SUMMARY_COLUMNS}, r.instructions, r.content, r.output, r.sources, r.error, r.created_by
         FROM app.reports r LEFT JOIN app.users u ON u.id = r.created_by
         WHERE r.id = $1 AND r.workspace_id = $2`,
        [id, workspaceId],
      )
      if (!row) return null
      return {
        ...mapSummary(row),
        instructions: row.instructions ? String(row.instructions) : null,
        content: row.content ? String(row.content) : null,
        output: (typeof row.output === 'string' ? JSON.parse(row.output) : row.output) as SlideOutline | null,
        sources: asJsonArray<{ documentId: string; title: string; source: string }>(row.sources),
        error: row.error ? String(row.error) : null,
        createdBy: row.created_by ? String(row.created_by) : null,
      }
    },

    async forJob(id: string): Promise<ReportJobInput | null> {
      const [row] = await db.query(`SELECT id, workspace_id, created_by, template, format, title, instructions, collection_ids, document_ids FROM app.reports WHERE id = $1`, [id])
      if (!row) return null
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        createdBy: row.created_by ? String(row.created_by) : null,
        template: row.template as ReportTemplate,
        format: row.format === 'json' ? 'json' : 'markdown',
        title: String(row.title),
        instructions: row.instructions ? String(row.instructions) : null,
        collectionIds: asUuidArray(row.collection_ids),
        documentIds: asUuidArray(row.document_ids),
      }
    },

    async setProgress(id: string, status: JobStatus, progress: string | null): Promise<void> {
      await db.query(`UPDATE app.reports SET status = $2, progress = $3 WHERE id = $1`, [id, status, progress])
    },

    async complete(id: string, result: { content: string; output: SlideOutline | null; sources: Array<{ documentId: string; title: string; source: string }> }): Promise<void> {
      await db.query(
        `UPDATE app.reports SET status = 'completed', progress = NULL, content = $2, output = $3::jsonb, sources = $4::jsonb, error = NULL, completed_at = now()
         WHERE id = $1`,
        [id, result.content, result.output ? JSON.stringify(result.output) : null, JSON.stringify(result.sources)],
      )
    },

    async fail(id: string, error: string): Promise<void> {
      await db.query(`UPDATE app.reports SET status = 'failed', progress = NULL, error = left($2, 1000), completed_at = now() WHERE id = $1`, [id, error])
    },

    async delete(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.reports WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId])
      return rows.length > 0
    },
  }
}
