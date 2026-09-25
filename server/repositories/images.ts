import type { ImageAspectRatio, ImageStyle } from '@/lib/constants'
import type { ImageDetail, ImageSource, ImageSummary, JobStatus } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { asJsonArray, toIso, toNullableNumber, toNumber } from '@/server/repositories/sql'

export interface ImageJobInput {
  id: string
  workspaceId: string
  createdBy: string | null
  collectionId: string | null
  documentIds: string[]
  prompt: string
  style: ImageStyle
  aspectRatio: ImageAspectRatio
}

export interface GeneratedImageResult {
  title: string | null
  altText: string | null
  finalPrompt: string
  sources: ImageSource[]
  model: string
  mimeType: string
  data: Uint8Array
  width: number | null
  height: number | null
}

const SUMMARY_COLUMNS = `i.id, i.prompt, i.style, i.aspect_ratio, i.status, i.progress, i.title, i.alt_text, i.mime_type, i.byte_size,
  i.width, i.height, i.created_at, i.completed_at, u.email AS created_by_email`

function asUuidArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.startsWith('{')) return value.slice(1, -1).split(',').filter(Boolean)
  return []
}

function mapSummary(row: Record<string, unknown>): ImageSummary {
  return {
    id: String(row.id),
    prompt: String(row.prompt),
    style: row.style as ImageStyle,
    aspectRatio: row.aspect_ratio as ImageAspectRatio,
    status: row.status as JobStatus,
    progress: row.progress ? String(row.progress) : null,
    title: row.title ? String(row.title) : null,
    altText: row.alt_text ? String(row.alt_text) : null,
    mimeType: row.mime_type ? String(row.mime_type) : null,
    byteSize: toNullableNumber(row.byte_size),
    width: toNullableNumber(row.width),
    height: toNullableNumber(row.height),
    createdByEmail: row.created_by_email ? String(row.created_by_email) : null,
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
  }
}

/**
 * Generated images. Bytes are written and read as base64 text (`encode` / `decode` in SQL), so
 * the same queries work with every Postgres driver regardless of how it maps bytea.
 */
export function imagesRepository(db: Db) {
  return {
    async create(input: Omit<ImageJobInput, 'id'>): Promise<ImageSummary> {
      const [row] = await db.query(
        `WITH i AS (
           INSERT INTO app.images (workspace_id, created_by, collection_id, document_ids, prompt, style, aspect_ratio)
           VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7)
           RETURNING *
         )
         SELECT ${SUMMARY_COLUMNS} FROM i LEFT JOIN app.users u ON u.id = i.created_by`,
        [input.workspaceId, input.createdBy, input.collectionId, input.documentIds, input.prompt, input.style, input.aspectRatio],
      )
      if (!row) throw new Error('Image insert returned no row')
      return mapSummary(row)
    },

    async list(workspaceId: string, limit = 60): Promise<ImageSummary[]> {
      const rows = await db.query(
        `SELECT ${SUMMARY_COLUMNS} FROM app.images i LEFT JOIN app.users u ON u.id = i.created_by
         WHERE i.workspace_id = $1 ORDER BY i.created_at DESC LIMIT $2`,
        [workspaceId, limit],
      )
      return rows.map(mapSummary)
    },

    async count(workspaceId: string): Promise<number> {
      const [row] = await db.query(`SELECT count(*)::int AS n FROM app.images WHERE workspace_id = $1`, [workspaceId])
      return toNumber(row?.n)
    },

    async get(workspaceId: string, id: string): Promise<(ImageDetail & { createdBy: string | null }) | null> {
      const [row] = await db.query(
        `SELECT ${SUMMARY_COLUMNS}, i.collection_id, i.document_ids, i.final_prompt, i.sources, i.model, i.error, i.created_by
         FROM app.images i LEFT JOIN app.users u ON u.id = i.created_by
         WHERE i.id = $1 AND i.workspace_id = $2`,
        [id, workspaceId],
      )
      if (!row) return null
      return {
        ...mapSummary(row),
        collectionId: row.collection_id ? String(row.collection_id) : null,
        documentIds: asUuidArray(row.document_ids),
        finalPrompt: row.final_prompt ? String(row.final_prompt) : null,
        sources: asJsonArray<ImageSource>(row.sources),
        model: row.model ? String(row.model) : null,
        error: row.error ? String(row.error) : null,
        createdBy: row.created_by ? String(row.created_by) : null,
      }
    },

    async forJob(id: string): Promise<ImageJobInput | null> {
      const [row] = await db.query(
        `SELECT id, workspace_id, created_by, collection_id, document_ids, prompt, style, aspect_ratio FROM app.images WHERE id = $1 AND status <> 'completed'`,
        [id],
      )
      if (!row) return null
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        createdBy: row.created_by ? String(row.created_by) : null,
        collectionId: row.collection_id ? String(row.collection_id) : null,
        documentIds: asUuidArray(row.document_ids),
        prompt: String(row.prompt),
        style: row.style as ImageStyle,
        aspectRatio: row.aspect_ratio as ImageAspectRatio,
      }
    },

    async setProgress(id: string, status: JobStatus, progress: string | null): Promise<void> {
      await db.query(`UPDATE app.images SET status = $2, progress = $3 WHERE id = $1`, [id, status, progress])
    },

    async complete(id: string, result: GeneratedImageResult): Promise<void> {
      await db.query(
        `UPDATE app.images SET status = 'completed', progress = NULL, error = NULL, completed_at = now(),
                title = $2, alt_text = $3, final_prompt = $4, sources = $5::jsonb, model = $6,
                mime_type = $7, data = decode($8, 'base64'), byte_size = $9, width = $10, height = $11
         WHERE id = $1`,
        [
          id,
          result.title,
          result.altText,
          result.finalPrompt,
          JSON.stringify(result.sources),
          result.model,
          result.mimeType,
          Buffer.from(result.data).toString('base64'),
          result.data.byteLength,
          result.width,
          result.height,
        ],
      )
    },

    async fail(id: string, error: string): Promise<void> {
      await db.query(`UPDATE app.images SET status = 'failed', progress = NULL, error = left($2, 500), completed_at = now() WHERE id = $1`, [id, error])
    },

    /** The stored image with the workspace it belongs to (the caller checks membership). */
    async file(id: string): Promise<{ workspaceId: string; mimeType: string; data: Uint8Array; title: string | null } | null> {
      const [row] = await db.query(
        `SELECT workspace_id, mime_type, title, encode(data, 'base64') AS data FROM app.images WHERE id = $1 AND status = 'completed' AND data IS NOT NULL`,
        [id],
      )
      if (!row) return null
      return {
        workspaceId: String(row.workspace_id),
        mimeType: String(row.mime_type),
        title: row.title ? String(row.title) : null,
        data: new Uint8Array(Buffer.from(String(row.data), 'base64')),
      }
    },

    async delete(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.images WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId])
      return rows.length > 0
    },
  }
}
