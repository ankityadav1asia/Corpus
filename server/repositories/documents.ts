import type { DocumentDetail, DocumentSummary, SourceType } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { DOCUMENT_COLUMNS, asLabels, documentValues, mapDocument, type NewDocument } from '@/server/repositories/document-rows'
import { toNumber, vectorLiteral } from '@/server/repositories/sql'

/** A document waiting to be indexed by the background job, with its extracted text. */
export interface PendingIngest {
  id: string
  workspaceId: string
  collectionId: string
  createdBy: string | null
  title: string
  text: string
  replaceExisting: boolean
  /** Chunks already stored by an earlier (interrupted) run. */
  storedChunks: number
  /** Imported by a connector sync (which reports once for the whole sync). */
  fromConnector: boolean
}

export interface ChunkInput {
  content: string
  embedding: readonly number[]
}

export interface SearchHit {
  chunkId: string
  documentId: string
  collectionId: string
  content: string
  title: string
  source: string
  sourceType: SourceType
  /** Cosine similarity (vector search only). */
  similarity: number | null
}

interface SearchScope {
  workspaceId: string
  /** null = every notebook in the workspace. */
  collectionId: string | null
  limit: number
}

const CHUNK_INSERT_BATCH = 20

function mapHit(row: Record<string, unknown>): SearchHit {
  return {
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    collectionId: String(row.collection_id),
    content: String(row.content),
    title: String(row.title),
    source: String(row.source),
    sourceType: row.source_type as SourceType,
    similarity: row.similarity === undefined || row.similarity === null ? null : toNumber(row.similarity),
  }
}

/** Documents: their lifecycle (queued → indexed → ready or failed), search, and texts for the studio. */
export function documentsRepository(db: Db) {
  return {
    async list(workspaceId: string, collectionId?: string): Promise<DocumentSummary[]> {
      const params: unknown[] = [workspaceId]
      let where = `workspace_id = $1`
      if (collectionId) {
        params.push(collectionId)
        where += ` AND collection_id = $2`
      }
      const rows = await db.query(`SELECT ${DOCUMENT_COLUMNS} FROM app.documents WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params)
      return rows.map(mapDocument)
    },

    async get(workspaceId: string, id: string): Promise<DocumentSummary | null> {
      const [row] = await db.query(`SELECT ${DOCUMENT_COLUMNS} FROM app.documents WHERE id = $1 AND workspace_id = $2`, [id, workspaceId])
      return row ? mapDocument(row) : null
    },

    /** Documents start as 'processing' and are invisible to search until markReady. */
    async createProcessing(input: NewDocument): Promise<DocumentSummary> {
      const [row] = await db.query(
        `INSERT INTO app.documents (workspace_id, collection_id, created_by, source_type, source, title, total_chunks, byte_size, connector_source_id, external_id, external_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${DOCUMENT_COLUMNS}`,
        documentValues(input),
      )
      if (!row) throw new Error('Document insert returned no row')
      return mapDocument(row)
    },

    /** Creates a 'processing' document together with the text the background job will index. */
    async createQueued(input: NewDocument, text: string, replaceExisting: boolean): Promise<DocumentSummary> {
      const [row] = await db.query(
        `WITH document AS (
           INSERT INTO app.documents (workspace_id, collection_id, created_by, source_type, source, title, total_chunks, byte_size, connector_source_id, external_id, external_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING ${DOCUMENT_COLUMNS}
         ),
         upload AS (
           INSERT INTO app.document_uploads (document_id, text, replace_existing) SELECT id, $12, $13 FROM document
         )
         SELECT * FROM document`,
        [...documentValues(input), text, replaceExisting],
      )
      if (!row) throw new Error('Document insert returned no row')
      return mapDocument(row)
    },

    /** What the ingest job needs; null when the document is gone or no longer waiting. */
    async pendingIngest(id: string): Promise<PendingIngest | null> {
      const [row] = await db.query(
        `SELECT d.id, d.workspace_id, d.collection_id, d.created_by, d.title, u.text, u.replace_existing, d.connector_source_id IS NOT NULL AS from_connector,
                (SELECT count(*) FROM app.chunks c WHERE c.document_id = d.id)::int AS stored
         FROM app.documents d JOIN app.document_uploads u ON u.document_id = d.id
         WHERE d.id = $1 AND d.status = 'processing'`,
        [id],
      )
      if (!row) return null
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        collectionId: String(row.collection_id),
        createdBy: row.created_by ? String(row.created_by) : null,
        title: String(row.title),
        text: String(row.text),
        replaceExisting: Boolean(row.replace_existing),
        storedChunks: toNumber(row.stored),
        fromConnector: Boolean(row.from_connector),
      }
    },

    /** Who added a document (for notifications). */
    async creator(id: string): Promise<{ createdBy: string | null; workspaceId: string } | null> {
      const [row] = await db.query(`SELECT created_by, workspace_id FROM app.documents WHERE id = $1`, [id])
      return row ? { createdBy: row.created_by ? String(row.created_by) : null, workspaceId: String(row.workspace_id) } : null
    },

    /** Progress while indexing (chunks stored so far). */
    async setIndexedCount(id: string, chunkCount: number): Promise<void> {
      await db.query(`UPDATE app.documents SET chunk_count = $2 WHERE id = $1 AND status = 'processing'`, [id, chunkCount])
    },

    /** Marks a waiting document as failed (it keeps its text, so it can be retried). */
    async failIngest(id: string, error: string): Promise<DocumentSummary | null> {
      const [row] = await db.query(`UPDATE app.documents SET status = 'failed', error = left($2, 500) WHERE id = $1 AND status = 'processing' RETURNING ${DOCUMENT_COLUMNS}`, [
        id,
        error,
      ])
      return row ? mapDocument(row) : null
    },

    /** Puts a failed document back in the queue; null unless it failed and still has its text (or media). */
    async retryIngest(workspaceId: string, id: string): Promise<DocumentSummary | null> {
      const [row] = await db.query(
        `UPDATE app.documents d SET status = 'processing', error = NULL
         WHERE d.id = $1 AND d.workspace_id = $2 AND d.status = 'failed'
           AND (EXISTS (SELECT 1 FROM app.document_uploads u WHERE u.document_id = d.id)
                OR EXISTS (SELECT 1 FROM app.document_media m WHERE m.document_id = d.id))
         RETURNING ${DOCUMENT_COLUMNS}`,
        [id, workspaceId],
      )
      return row ? mapDocument(row) : null
    },

    /** A document and its chunks in order, for reading it in full (the source viewer). */
    async detail(workspaceId: string, id: string, maxChunks: number): Promise<DocumentDetail | null> {
      const [row] = await db.query(`SELECT ${DOCUMENT_COLUMNS} FROM app.documents WHERE id = $1 AND workspace_id = $2`, [id, workspaceId])
      if (!row) return null
      const chunks = await db.query(`SELECT id, chunk_index, content, labels FROM app.chunks WHERE document_id = $1 ORDER BY chunk_index LIMIT $2`, [id, maxChunks])
      return {
        document: mapDocument(row),
        chunks: chunks.map((chunk) => ({ id: String(chunk.id), chunkIndex: toNumber(chunk.chunk_index), content: String(chunk.content), labels: asLabels(chunk.labels) })),
      }
    },

    async insertChunks(document: { id: string; workspaceId: string; collectionId: string }, chunks: readonly ChunkInput[], firstIndex = 0, embeddingModel: string | null = null) {
      for (let start = 0; start < chunks.length; start += CHUNK_INSERT_BATCH) {
        const batch = chunks.slice(start, start + CHUNK_INSERT_BATCH)
        const params: unknown[] = [document.id, document.workspaceId, document.collectionId, embeddingModel]
        const values = batch.map((chunk, offset) => {
          params.push(firstIndex + start + offset, chunk.content, vectorLiteral(chunk.embedding))
          const base = params.length - 2
          return `($1, $2, $3, $${base}, $${base + 1}, $${base + 2}::vector, $4)`
        })
        await db.query(`INSERT INTO app.chunks (document_id, workspace_id, collection_id, chunk_index, content, embedding, embedding_model) VALUES ${values.join(', ')}`, params)
      }
    },

    /** Makes the document searchable and drops the staged text. */
    async markReady(id: string, chunkCount: number, charCount: number): Promise<DocumentSummary> {
      const [row] = await db.query(
        `WITH ready AS (
           UPDATE app.documents SET status = 'ready', chunk_count = $2, total_chunks = $2, char_count = $3, error = NULL, progress = NULL
           WHERE id = $1
           RETURNING ${DOCUMENT_COLUMNS}
         ),
         staged AS (
           DELETE FROM app.document_uploads WHERE document_id = $1
         ),
         media AS (
           DELETE FROM app.document_media WHERE document_id = $1
         ),
         pages AS (
           DELETE FROM app.document_pages WHERE document_id = $1
         )
         SELECT * FROM ready`,
        [id, chunkCount, charCount],
      )
      if (!row) throw new Error('Document disappeared while ingesting')
      return mapDocument(row)
    },

    async delete(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.documents WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId])
      return rows.length > 0
    },

    /** Re-ingesting the same URL / file / video replaces the older copies. */
    async deleteOtherVersions(workspaceId: string, keep: DocumentSummary): Promise<number> {
      const rows = await db.query(
        `DELETE FROM app.documents
         WHERE workspace_id = $1 AND collection_id = $2 AND source_type = $3 AND source = $4 AND id <> $5
         RETURNING id`,
        [workspaceId, keep.collectionId, keep.sourceType, keep.source, keep.id],
      )
      return rows.length
    },

    async clearCollection(workspaceId: string, collectionId: string): Promise<number> {
      const rows = await db.query(`DELETE FROM app.documents WHERE workspace_id = $1 AND collection_id = $2 RETURNING id`, [workspaceId, collectionId])
      return rows.length
    },

    /** `embeddingModel`: compare only with vectors of the same model (chunks without a recorded model are kept). */
    async vectorSearch(scope: SearchScope & { embedding: readonly number[]; embeddingModel?: string }): Promise<SearchHit[]> {
      const params: unknown[] = [scope.workspaceId, vectorLiteral(scope.embedding), scope.limit]
      let collectionFilter = ''
      if (scope.collectionId) {
        params.push(scope.collectionId)
        collectionFilter = `AND c.collection_id = $${params.length}`
      }
      if (scope.embeddingModel) {
        params.push(scope.embeddingModel)
        collectionFilter += ` AND (c.embedding_model IS NULL OR c.embedding_model = $${params.length})`
      }
      const rows = await db.query(
        `SELECT c.id AS chunk_id, c.document_id, c.collection_id, c.content, d.title, d.source, d.source_type,
                1 - (c.embedding <=> $2::vector) AS similarity
         FROM app.chunks c
         JOIN app.documents d ON d.id = c.document_id
         WHERE c.workspace_id = $1 AND d.status = 'ready' ${collectionFilter}
         ORDER BY c.embedding <=> $2::vector
         LIMIT $3`,
        params,
      )
      return rows.map(mapHit)
    },

    /** websearch_to_tsquery accepts arbitrary user text without syntax errors. */
    async keywordSearch(scope: SearchScope & { query: string }): Promise<SearchHit[]> {
      const params: unknown[] = [scope.workspaceId, scope.query, scope.limit]
      let collectionFilter = ''
      if (scope.collectionId) {
        params.push(scope.collectionId)
        collectionFilter = `AND c.collection_id = $4`
      }
      const rows = await db.query(
        `SELECT c.id AS chunk_id, c.document_id, c.collection_id, c.content, d.title, d.source, d.source_type,
                NULL::float8 AS similarity
         FROM app.chunks c
         JOIN app.documents d ON d.id = c.document_id
         CROSS JOIN LATERAL websearch_to_tsquery('english', $2) AS q(query)
         WHERE c.workspace_id = $1 AND d.status = 'ready' AND c.tsv @@ q.query ${collectionFilter}
         ORDER BY ts_rank_cd(c.tsv, q.query) DESC, c.id
         LIMIT $3`,
        params,
      )
      return rows.map(mapHit)
    },

    /** What the user sees while a source is being read ("Reading scanned pages 3/12"). */
    async setProgress(id: string, progress: string | null): Promise<void> {
      await db.query(`UPDATE app.documents SET progress = $2 WHERE id = $1 AND status = 'processing'`, [id, progress])
    },

    async totals(workspaceId: string): Promise<{ collections: number; documents: number; chunks: number }> {
      const [row] = await db.query(
        `SELECT
           (SELECT count(*) FROM app.collections WHERE workspace_id = $1)::int AS collections,
           (SELECT count(*) FROM app.documents WHERE workspace_id = $1 AND status = 'ready')::int AS documents,
           (SELECT coalesce(sum(chunk_count), 0) FROM app.documents WHERE workspace_id = $1 AND status = 'ready')::int AS chunks`,
        [workspaceId],
      )
      return { collections: toNumber(row?.collections), documents: toNumber(row?.documents), chunks: toNumber(row?.chunks) }
    },

    /** Ready documents selected directly or through their notebooks (for synthesis reports). */
    async resolveReportDocuments(workspaceId: string, selection: { collectionIds: string[]; documentIds: string[] }, limit: number): Promise<Array<DocumentSummary>> {
      const rows = await db.query(
        `SELECT ${DOCUMENT_COLUMNS} FROM app.documents
         WHERE workspace_id = $1 AND status = 'ready'
           AND (collection_id = ANY($2::uuid[]) OR id = ANY($3::uuid[]))
         ORDER BY created_at DESC
         LIMIT $4`,
        [workspaceId, selection.collectionIds, selection.documentIds, limit],
      )
      return rows.map(mapDocument)
    },

    /** Document text rebuilt from its chunks, in order, capped at `maxChars` per document. */
    async documentTexts(workspaceId: string, documentIds: string[], maxChars: number): Promise<Array<{ documentId: string; title: string; source: string; text: string }>> {
      const rows = await db.query(
        `SELECT d.id, d.title, d.source, left(string_agg(c.content, E'\\n\\n' ORDER BY c.chunk_index), $3) AS text
         FROM app.documents d JOIN app.chunks c ON c.document_id = d.id
         WHERE d.workspace_id = $1 AND d.id = ANY($2::uuid[]) AND d.status = 'ready'
         GROUP BY d.id, d.title, d.source`,
        [workspaceId, documentIds, maxChars],
      )
      return rows.map((row) => ({ documentId: String(row.id), title: String(row.title), source: String(row.source), text: String(row.text ?? '') }))
    },
  }
}
