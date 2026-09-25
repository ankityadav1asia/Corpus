import type { Role } from '@/lib/constants'
import type { Collection } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { pgErrorCode } from '@/server/http/errors'
import { toIso, toNumber } from '@/server/repositories/sql'

export const DEFAULT_COLLECTION_NAME = 'General'

/** A notebook as stored, plus the caller's role override (the effective role is decided in server/auth). */
export type CollectionRecord = Omit<Collection, 'myRole'> & { override: Role | null }

function mapCollection(row: Record<string, unknown>): CollectionRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    documentCount: toNumber(row.document_count),
    chunkCount: toNumber(row.chunk_count),
    createdAt: toIso(row.created_at),
    override: (row.override as Role | null) ?? null,
  }
}

export function collectionsRepository(db: Db) {
  return {
    async list(workspaceId: string, userId: string): Promise<CollectionRecord[]> {
      const rows = await db.query(
        `SELECT c.id, c.name, c.created_at, cr.role AS override,
                count(d.id) FILTER (WHERE d.status = 'ready')::int AS document_count,
                coalesce(sum(d.chunk_count) FILTER (WHERE d.status = 'ready'), 0)::int AS chunk_count
         FROM app.collections c
         LEFT JOIN app.documents d ON d.collection_id = c.id
         LEFT JOIN app.collection_roles cr ON cr.collection_id = c.id AND cr.user_id = $2
         WHERE c.workspace_id = $1
         GROUP BY c.id, cr.role
         ORDER BY c.created_at, c.name`,
        [workspaceId, userId],
      )
      return rows.map(mapCollection)
    },

    /** A notebook of this workspace (null if it does not exist there) with the user's override. */
    async get(workspaceId: string, id: string, userId: string): Promise<{ id: string; name: string; override: Role | null } | null> {
      const [row] = await db.query<{ id: string; name: string; override: Role | null }>(
        `SELECT c.id, c.name, cr.role AS override
         FROM app.collections c
         LEFT JOIN app.collection_roles cr ON cr.collection_id = c.id AND cr.user_id = $3
         WHERE c.id = $1 AND c.workspace_id = $2`,
        [id, workspaceId, userId],
      )
      return row ? { id: String(row.id), name: String(row.name), override: row.override ?? null } : null
    },

    async count(workspaceId: string): Promise<number> {
      const [row] = await db.query(`SELECT count(*)::int AS n FROM app.collections WHERE workspace_id = $1`, [workspaceId])
      return toNumber(row?.n)
    },

    /** Returns null when the workspace already has a notebook with that name. */
    async create(workspaceId: string, createdBy: string, name: string): Promise<CollectionRecord | null> {
      const [row] = await db.query(
        `INSERT INTO app.collections (workspace_id, created_by, name) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id, name, created_at, 0 AS document_count, 0 AS chunk_count, NULL::text AS override`,
        [workspaceId, createdBy, name],
      )
      return row ? mapCollection(row) : null
    },

    async rename(workspaceId: string, id: string, name: string): Promise<'ok' | 'not_found' | 'conflict'> {
      try {
        const rows = await db.query(`UPDATE app.collections SET name = $3 WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId, name])
        return rows.length ? 'ok' : 'not_found'
      } catch (error) {
        if (pgErrorCode(error) === '23505') return 'conflict'
        throw error
      }
    },

    /** Cascades to documents and chunks; conversations keep their history (collection set to NULL). */
    async delete(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.collections WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId])
      return rows.length > 0
    },

    /** Every workspace always has at least one notebook to ingest into. */
    async ensureDefault(workspaceId: string, createdBy: string): Promise<void> {
      await db.query(
        `INSERT INTO app.collections (workspace_id, created_by, name)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (SELECT 1 FROM app.collections WHERE workspace_id = $1)
         ON CONFLICT DO NOTHING`,
        [workspaceId, createdBy, DEFAULT_COLLECTION_NAME],
      )
    },

    /** Workspace members with their per-notebook override (if any). */
    async roleOverrides(collectionId: string): Promise<Array<{ userId: string; role: Role }>> {
      const rows = await db.query<{ user_id: string; role: Role }>(`SELECT user_id, role FROM app.collection_roles WHERE collection_id = $1`, [collectionId])
      return rows.map((row) => ({ userId: String(row.user_id), role: row.role }))
    },

    /** Sets (or with null, removes) a member's role override on a notebook. */
    async setRoleOverride(collectionId: string, userId: string, role: Role | null): Promise<void> {
      if (role === null) {
        await db.query(`DELETE FROM app.collection_roles WHERE collection_id = $1 AND user_id = $2`, [collectionId, userId])
        return
      }
      await db.query(
        `INSERT INTO app.collection_roles (collection_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (collection_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [collectionId, userId, role],
      )
    },
  }
}
