import type { DocumentSummary, MediaKind } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { DOCUMENT_COLUMNS, documentValues, mapDocument, type NewDocument } from '@/server/repositories/document-rows'
import { base64Parts, readPartsInBatches, toNullableNumber, toNumber } from '@/server/repositories/sql'

/** Media waiting to be read (OCR, transcription) before it can be indexed. */
export interface PendingMedia {
  id: string
  workspaceId: string
  collectionId: string
  createdBy: string | null
  title: string
  kind: MediaKind
  mimeType: string
  fileName: string
  byteSize: number
  pageCount: number | null
  replaceExisting: boolean
}

function mapPendingMedia(row: Record<string, unknown>): PendingMedia {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    collectionId: String(row.collection_id),
    createdBy: row.created_by ? String(row.created_by) : null,
    title: String(row.title),
    kind: row.kind as MediaKind,
    mimeType: String(row.mime_type),
    fileName: String(row.file_name),
    byteSize: toNumber(row.byte_size),
    pageCount: toNullableNumber(row.page_count),
    replaceExisting: Boolean(row.replace_existing),
  }
}

/**
 * Stored bytes of sources: media waiting to be read (OCR, transcription) with the pages read so
 * far, and original files kept for viewing (PDFs). Stored in base64 parts, below driver limits.
 */
export function mediaRepository(db: Db) {
  return {
    /**
     * A 'processing' document whose media must be read first (OCR or transcription). The bytes are
     * stored in parts; `pages` carries text already extracted from a PDF's text layer.
     */
    async createQueued(
      input: NewDocument,
      media: {
        kind: MediaKind
        mimeType: string
        fileName: string
        pageCount: number | null
        replaceExisting: boolean
        data: Uint8Array
        progress: string
        pages?: ReadonlyArray<{ page: number; text: string }>
      },
    ): Promise<DocumentSummary> {
      const [row] = await db.query(
        `WITH document AS (
           INSERT INTO app.documents (workspace_id, collection_id, created_by, source_type, source, title, total_chunks, byte_size, connector_source_id, external_id, external_version, progress, media_kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING ${DOCUMENT_COLUMNS}
         ),
         media AS (
           INSERT INTO app.document_media (document_id, kind, mime_type, file_name, byte_size, page_count, replace_existing)
           SELECT id, $13, $14, $15, $16, $17, $18 FROM document
         )
         SELECT * FROM document`,
        [...documentValues(input), media.progress, media.kind, media.mimeType, media.fileName.slice(0, 500), media.data.byteLength, media.pageCount, media.replaceExisting],
      )
      if (!row) throw new Error('Document insert returned no row')
      const document = mapDocument(row)
      try {
        for (const [part, data] of base64Parts(media.data).entries()) {
          await db.query(`INSERT INTO app.document_media_parts (document_id, part, data) VALUES ($1, $2, decode($3, 'base64'))`, [document.id, part, data])
        }
        for (const page of media.pages ?? []) {
          await db.query(`INSERT INTO app.document_pages (document_id, page, text, method) VALUES ($1, $2, $3, 'text')`, [document.id, page.page, page.text])
        }
      } catch (error) {
        await db.query(`DELETE FROM app.documents WHERE id = $1`, [document.id]).catch(() => undefined)
        throw error
      }
      return document
    },

    /** Media still waiting to be read; null when gone, already read, or no longer processing. */
    async pending(id: string): Promise<PendingMedia | null> {
      const [row] = await db.query(
        `SELECT d.id, d.workspace_id, d.collection_id, d.created_by, d.title, m.kind, m.mime_type, m.file_name, m.byte_size, m.page_count, m.replace_existing
         FROM app.documents d JOIN app.document_media m ON m.document_id = d.id
         WHERE d.id = $1 AND d.status = 'processing'
           AND NOT EXISTS (SELECT 1 FROM app.document_uploads u WHERE u.document_id = d.id)`,
        [id],
      )
      return row ? mapPendingMedia(row) : null
    },

    /** Keeps the original file (e.g. a PDF) for viewing; replaces an earlier copy. */
    async storeFile(documentId: string, file: { mimeType: string; fileName: string; data: Uint8Array }): Promise<void> {
      await db.query(`DELETE FROM app.document_files WHERE document_id = $1`, [documentId])
      await db.query(`INSERT INTO app.document_files (document_id, mime_type, file_name, byte_size) VALUES ($1, $2, $3, $4)`, [
        documentId,
        file.mimeType,
        file.fileName.slice(0, 500),
        file.data.byteLength,
      ])
      for (const [part, data] of base64Parts(file.data).entries()) {
        await db.query(`INSERT INTO app.document_file_parts (document_id, part, data) VALUES ($1, $2, decode($3, 'base64'))`, [documentId, part, data])
      }
    },

    async fileInfo(workspaceId: string, documentId: string): Promise<{ mimeType: string; fileName: string; byteSize: number } | null> {
      const [row] = await db.query(
        `SELECT f.mime_type, f.file_name, f.byte_size FROM app.document_files f JOIN app.documents d ON d.id = f.document_id
         WHERE f.document_id = $1 AND d.workspace_id = $2`,
        [documentId, workspaceId],
      )
      return row ? { mimeType: String(row.mime_type), fileName: String(row.file_name), byteSize: toNumber(row.byte_size) } : null
    },

    async fileBytes(workspaceId: string, documentId: string): Promise<Uint8Array> {
      return readPartsInBatches((offset, limit) =>
        db.query(
          `SELECT encode(p.data, 'base64') AS data FROM app.document_file_parts p JOIN app.documents d ON d.id = p.document_id
           WHERE p.document_id = $1 AND d.workspace_id = $2 ORDER BY p.part LIMIT $3 OFFSET $4`,
          [documentId, workspaceId, limit, offset],
        ),
      )
    },

    /** The stored media bytes, reassembled. */
    async bytes(id: string): Promise<Uint8Array> {
      return readPartsInBatches((offset, limit) =>
        db.query(`SELECT encode(data, 'base64') AS data FROM app.document_media_parts WHERE document_id = $1 ORDER BY part LIMIT $2 OFFSET $3`, [id, limit, offset]),
      )
    },

    async pageTexts(id: string): Promise<Array<{ page: number; text: string; method: 'text' | 'ocr' }>> {
      const rows = await db.query(`SELECT page, text, method FROM app.document_pages WHERE document_id = $1 ORDER BY page`, [id])
      return rows.map((row) => ({ page: toNumber(row.page), text: String(row.text), method: row.method === 'ocr' ? 'ocr' : 'text' }))
    },

    async savePage(id: string, page: number, text: string, method: 'text' | 'ocr'): Promise<void> {
      await db.query(
        `INSERT INTO app.document_pages (document_id, page, text, method) VALUES ($1, $2, $3, $4)
         ON CONFLICT (document_id, page) DO UPDATE SET text = excluded.text, method = excluded.method`,
        [id, page, text, method],
      )
    },

    /** Media has been read: keep its text for indexing and drop the bytes. */
    async stageText(id: string, text: string, totalChunks: number, replaceExisting: boolean): Promise<void> {
      await db.query(
        `WITH upload AS (
           INSERT INTO app.document_uploads (document_id, text, replace_existing) VALUES ($1, $2, $4)
           ON CONFLICT (document_id) DO UPDATE SET text = excluded.text, replace_existing = excluded.replace_existing
         ),
         media AS (
           DELETE FROM app.document_media WHERE document_id = $1
         )
         UPDATE app.documents SET total_chunks = $3, progress = NULL WHERE id = $1`,
        [id, text, totalChunks, replaceExisting],
      )
    },
  }
}
