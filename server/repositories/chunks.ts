import type { ChunkDetail, ChunkMetadataValue, ChunkPage, ChunkRow, SourceType } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { asLabels } from '@/server/repositories/document-rows'
import { escapeLike, toIso, toNumber, vectorLiteral } from '@/server/repositories/sql'

export interface ChunkChanges {
  content?: string
  embedding?: readonly number[]
  /** Model that produced `embedding`. */
  embeddingModel?: string
  labels?: string[]
  metadata?: Record<string, ChunkMetadataValue>
}

const CHUNK_COLUMNS = `c.id, c.document_id, c.collection_id, c.chunk_index, c.content, c.labels, c.metadata, c.updated_at, d.title, d.source, d.source_type`

function asMetadata(value: unknown): Record<string, ChunkMetadataValue> {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, ChunkMetadataValue>) : {}
}

function mapChunk(row: Record<string, unknown>): ChunkRow {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    collectionId: String(row.collection_id),
    chunkIndex: toNumber(row.chunk_index),
    content: String(row.content),
    documentTitle: String(row.title),
    source: String(row.source),
    sourceType: row.source_type as SourceType,
    labels: asLabels(row.labels),
    metadata: asMetadata(row.metadata),
    updatedAt: row.updated_at ? toIso(row.updated_at) : null,
  }
}

/** Passages of ready documents: the chunk editor, and re-embedding after a model change. */
export function chunksRepository(db: Db) {
  /** Keeps document counters in sync after chunks are edited, added or removed. */
  async function refreshDocumentCounts(documentId: string) {
    await db.query(
      `UPDATE app.documents d SET
         chunk_count = (SELECT count(*) FROM app.chunks c WHERE c.document_id = d.id),
         char_count = (SELECT coalesce(sum(char_length(c.content)), 0) FROM app.chunks c WHERE c.document_id = d.id)
       WHERE d.id = $1`,
      [documentId],
    )
  }

  return {
    async list(options: { workspaceId: string; collectionId?: string; documentId?: string; label?: string; q?: string; page: number; pageSize: number }): Promise<ChunkPage> {
      const params: unknown[] = [options.workspaceId]
      const where = ['c.workspace_id = $1', `d.status = 'ready'`]
      if (options.collectionId) {
        params.push(options.collectionId)
        where.push(`c.collection_id = $${params.length}`)
      }
      if (options.documentId) {
        params.push(options.documentId)
        where.push(`c.document_id = $${params.length}`)
      }
      if (options.label) {
        params.push(options.label)
        where.push(`c.labels @> ARRAY[$${params.length}::text]`)
      }
      if (options.q) {
        params.push(`%${escapeLike(options.q)}%`)
        where.push(`(c.content ILIKE $${params.length} ESCAPE '\\' OR d.title ILIKE $${params.length} ESCAPE '\\')`)
      }
      const from = `FROM app.chunks c JOIN app.documents d ON d.id = c.document_id WHERE ${where.join(' AND ')}`
      const [rows, [countRow]] = await Promise.all([
        db.query(
          `SELECT ${CHUNK_COLUMNS}
           ${from}
           ORDER BY d.created_at DESC, c.document_id, c.chunk_index
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, options.pageSize, options.page * options.pageSize],
        ),
        db.query(`SELECT count(*)::int AS total ${from}`, params),
      ])
      return { items: rows.map(mapChunk), total: toNumber(countRow?.total), page: options.page, pageSize: options.pageSize }
    },

    /** One chunk with a summary of its vector (the full 3072 numbers are never sent to the browser). */
    async get(workspaceId: string, id: string): Promise<ChunkDetail | null> {
      const [row] = await db.query(
        `SELECT ${CHUNK_COLUMNS},
                vector_dims(c.embedding) AS dims, vector_norm(c.embedding) AS norm,
                (c.embedding::real[])[1:8] AS preview
         FROM app.chunks c JOIN app.documents d ON d.id = c.document_id
         WHERE c.id = $1 AND c.workspace_id = $2`,
        [id, workspaceId],
      )
      if (!row) return null
      const preview = Array.isArray(row.preview) ? row.preview.map(Number) : []
      return {
        ...mapChunk(row),
        embedding: { dimensions: toNumber(row.dims), norm: Math.round(toNumber(row.norm) * 10_000) / 10_000, preview: preview.map((v) => Math.round(v * 10_000) / 10_000) },
      }
    },

    /** Applies an edit; `embedding` must accompany a content change. Returns null if the chunk is not in the workspace. */
    async update(workspaceId: string, id: string, changes: ChunkChanges, updatedBy: string): Promise<ChunkRow | null> {
      const [row] = await db.query(
        `WITH updated AS (
           UPDATE app.chunks SET
             content = coalesce($3, content),
             embedding = coalesce($4::vector, embedding),
             embedding_model = CASE WHEN $4::vector IS NULL THEN embedding_model ELSE $8 END,
             labels = coalesce($5::text[], labels),
             metadata = coalesce($6::jsonb, metadata),
             updated_at = now(),
             updated_by = $7
           WHERE id = $1 AND workspace_id = $2
           RETURNING *
         )
         SELECT ${CHUNK_COLUMNS} FROM updated c JOIN app.documents d ON d.id = c.document_id`,
        [
          id,
          workspaceId,
          changes.content ?? null,
          changes.embedding ? vectorLiteral(changes.embedding) : null,
          changes.labels ?? null,
          changes.metadata ? JSON.stringify(changes.metadata) : null,
          updatedBy,
          changes.embeddingModel ?? null,
        ],
      )
      if (!row) return null
      if (changes.content !== undefined) await refreshDocumentCounts(String(row.document_id))
      return mapChunk(row)
    },

    /** Adds a hand-written chunk at the end of a ready document. */
    async append(
      workspaceId: string,
      documentId: string,
      input: { content: string; embedding: readonly number[]; embeddingModel?: string; labels: string[]; metadata: Record<string, ChunkMetadataValue> },
      createdBy: string,
    ): Promise<ChunkRow | null> {
      const [row] = await db.query(
        `WITH inserted AS (
           INSERT INTO app.chunks (document_id, workspace_id, collection_id, chunk_index, content, embedding, labels, metadata, updated_at, updated_by, embedding_model)
           SELECT d.id, d.workspace_id, d.collection_id,
                  coalesce((SELECT max(chunk_index) + 1 FROM app.chunks WHERE document_id = d.id), 0),
                  $3, $4::vector, $5::text[], $6::jsonb, now(), $7, $8
           FROM app.documents d
           WHERE d.id = $1 AND d.workspace_id = $2 AND d.status = 'ready'
           RETURNING *
         )
         SELECT ${CHUNK_COLUMNS} FROM inserted c JOIN app.documents d ON d.id = c.document_id`,
        [documentId, workspaceId, input.content, vectorLiteral(input.embedding), input.labels, JSON.stringify(input.metadata), createdBy, input.embeddingModel ?? null],
      )
      if (!row) return null
      await refreshDocumentCounts(documentId)
      return mapChunk(row)
    },

    /** Where a chunk lives (for permission checks before editing it). */
    async location(workspaceId: string, id: string): Promise<{ collectionId: string; documentId: string } | null> {
      const [row] = await db.query<{ collection_id: string; document_id: string }>(
        `SELECT c.collection_id, c.document_id FROM app.chunks c JOIN app.documents d ON d.id = c.document_id
         WHERE c.id = $1 AND c.workspace_id = $2 AND d.status = 'ready'`,
        [id, workspaceId],
      )
      return row ? { collectionId: String(row.collection_id), documentId: String(row.document_id) } : null
    },

    /** Full text of specific chunks (for background evaluation); missing ids are skipped. */
    async texts(workspaceId: string, ids: readonly string[]): Promise<Array<{ id: string; content: string }>> {
      if (ids.length === 0) return []
      const rows = await db.query<{ id: string; content: string }>(`SELECT id, content FROM app.chunks WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, [...ids]])
      const byId = new Map(rows.map((row) => [String(row.id), String(row.content)]))
      return ids.flatMap((id) => (byId.has(id) ? [{ id, content: byId.get(id)! }] : []))
    },

    async delete(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query<{ document_id: string }>(`DELETE FROM app.chunks WHERE id = $1 AND workspace_id = $2 RETURNING document_id`, [id, workspaceId])
      if (!rows[0]) return false
      await refreshDocumentCounts(String(rows[0].document_id))
      return true
    },

    /** How many passages in the workspace were embedded with a different model than `model`. */
    async embeddingStatus(workspaceId: string, model: string): Promise<{ total: number; stale: number }> {
      const [row] = await db.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE embedding_model IS DISTINCT FROM $2)::int AS stale FROM app.chunks WHERE workspace_id = $1`,
        [workspaceId, model],
      )
      return { total: toNumber(row?.total), stale: toNumber(row?.stale) }
    },

    async toReembed(workspaceId: string, model: string, limit: number): Promise<Array<{ id: string; content: string }>> {
      const rows = await db.query(`SELECT id, content FROM app.chunks WHERE workspace_id = $1 AND embedding_model IS DISTINCT FROM $2 ORDER BY id LIMIT $3`, [
        workspaceId,
        model,
        limit,
      ])
      return rows.map((row) => ({ id: String(row.id), content: String(row.content) }))
    },

    async setEmbeddings(workspaceId: string, rows: ReadonlyArray<{ id: string; embedding: readonly number[] }>, model: string): Promise<void> {
      for (const row of rows) {
        await db.query(`UPDATE app.chunks SET embedding = $3::vector, embedding_model = $4 WHERE id = $1 AND workspace_id = $2`, [
          row.id,
          workspaceId,
          vectorLiteral(row.embedding),
          model,
        ])
      }
    },
  }
}
