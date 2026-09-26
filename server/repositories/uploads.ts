import type { Db } from '@/server/db/client'
import { base64Parts, readPartsInBatches, toIso, toNumber } from '@/server/repositories/sql'

export interface UploadSessionRecord {
  id: string
  workspaceId: string
  collectionId: string
  createdBy: string
  fileName: string
  byteSize: number
  partBytes: number
  expiresAt: string
}

const COLUMNS = 'id, workspace_id, collection_id, created_by, file_name, byte_size, part_bytes, expires_at'

function mapSession(row: Record<string, unknown>): UploadSessionRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    collectionId: String(row.collection_id),
    createdBy: String(row.created_by),
    fileName: String(row.file_name),
    byteSize: toNumber(row.byte_size),
    partBytes: toNumber(row.part_bytes),
    expiresAt: toIso(row.expires_at),
  }
}

/**
 * Uploads in parts (server/ingestion/uploads.ts). Reads and deletes are scoped to the uploader in
 * their workspace, so anyone else's upload id behaves like a missing one.
 */
export function uploadsRepository(db: Db) {
  return {
    async create(input: Omit<UploadSessionRecord, 'id' | 'expiresAt'> & { expiresAt: Date }): Promise<UploadSessionRecord> {
      const [row] = await db.query(
        `INSERT INTO app.upload_sessions (workspace_id, collection_id, created_by, file_name, byte_size, part_bytes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLUMNS}`,
        [input.workspaceId, input.collectionId, input.createdBy, input.fileName.slice(0, 500), input.byteSize, input.partBytes, input.expiresAt.toISOString()],
      )
      if (!row) throw new Error('Upload insert returned no row')
      return mapSession(row)
    },

    /** The user's own upload in the workspace, until it expires; null otherwise. */
    async get(workspaceId: string, userId: string, id: string): Promise<UploadSessionRecord | null> {
      const [row] = await db.query(`SELECT ${COLUMNS} FROM app.upload_sessions WHERE id = $1 AND workspace_id = $2 AND created_by = $3 AND expires_at > now()`, [
        id,
        workspaceId,
        userId,
      ])
      return row ? mapSession(row) : null
    },

    /** Uploads the user started in the workspace that are neither completed nor expired. */
    async openCount(workspaceId: string, userId: string): Promise<number> {
      const [row] = await db.query(`SELECT count(*)::int AS n FROM app.upload_sessions WHERE workspace_id = $1 AND created_by = $2 AND expires_at > now()`, [workspaceId, userId])
      return toNumber(row?.n)
    },

    /** Stores part `index` in pieces of at most BYTE_PART_SIZE; sending the same part again replaces it. */
    async putPart(id: string, index: number, bytes: Uint8Array): Promise<void> {
      for (const [piece, data] of base64Parts(bytes).entries()) {
        await db.query(
          `INSERT INTO app.upload_session_parts (upload_id, part, piece, data) VALUES ($1, $2, $3, decode($4, 'base64'))
           ON CONFLICT (upload_id, part, piece) DO UPDATE SET data = EXCLUDED.data`,
          [id, index, piece, data],
        )
      }
    },

    /** Bytes stored so far. Every part has an exact length, so this equals the file size only when all arrived. */
    async receivedBytes(id: string): Promise<number> {
      const [row] = await db.query(`SELECT coalesce(sum(octet_length(data)), 0)::bigint AS bytes FROM app.upload_session_parts WHERE upload_id = $1`, [id])
      return toNumber(row?.bytes)
    },

    /** The whole file, parts and pieces in order. */
    async bytes(id: string): Promise<Uint8Array<ArrayBuffer>> {
      return readPartsInBatches((offset, limit) =>
        db.query(`SELECT encode(data, 'base64') AS data FROM app.upload_session_parts WHERE upload_id = $1 ORDER BY part, piece LIMIT $2 OFFSET $3`, [id, limit, offset]),
      )
    },

    /** Removes the user's upload with its parts; false when there was none (already completed, aborted or someone else's). */
    async delete(workspaceId: string, userId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.upload_sessions WHERE id = $1 AND workspace_id = $2 AND created_by = $3 RETURNING id`, [id, workspaceId, userId])
      return rows.length > 0
    },

    /** Housekeeping: drops uploads that were never completed, with their parts. */
    async purgeExpired(): Promise<number> {
      const rows = await db.query(`DELETE FROM app.upload_sessions WHERE expires_at <= now() RETURNING id`)
      return rows.length
    },
  }
}
