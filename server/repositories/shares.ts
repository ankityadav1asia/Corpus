import type { ShareKind, SharedSnapshot } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { toIso } from '@/server/repositories/sql'

export interface ShareRecord {
  id: string
  workspaceId: string
  kind: ShareKind
  targetId: string
  title: string
  tokenSealed: string
  viewCount: number
  lastViewedAt: string | null
  createdAt: string
  createdBy: string | null
  createdByEmail: string | null
}

const COLUMNS = `s.id, s.workspace_id, s.kind, s.target_id, s.title, s.token_sealed, s.view_count, s.last_viewed_at, s.created_at, s.created_by, u.email AS created_by_email`

function mapShare(row: Record<string, unknown>): ShareRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: row.kind === 'report' ? 'report' : 'conversation',
    targetId: String(row.target_id),
    title: String(row.title),
    tokenSealed: String(row.token_sealed),
    viewCount: Number(row.view_count ?? 0),
    lastViewedAt: row.last_viewed_at ? toIso(row.last_viewed_at) : null,
    createdAt: toIso(row.created_at),
    createdBy: row.created_by ? String(row.created_by) : null,
    createdByEmail: row.created_by_email ? String(row.created_by_email) : null,
  }
}

/** Public read-only links. Lookups by token go through its SHA-256 hash; the token itself is never stored in the clear. */
export function sharesRepository(db: Db) {
  return {
    async create(input: {
      workspaceId: string
      createdBy: string
      kind: ShareKind
      targetId: string
      title: string
      tokenHash: string
      tokenSealed: string
      snapshot: SharedSnapshot
    }): Promise<ShareRecord> {
      const [row] = await db.query(
        `WITH created AS (
           INSERT INTO app.share_links (workspace_id, created_by, kind, target_id, title, token_hash, token_sealed, snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           RETURNING *
         )
         SELECT ${COLUMNS} FROM created s LEFT JOIN app.users u ON u.id = s.created_by`,
        [input.workspaceId, input.createdBy, input.kind, input.targetId, input.title, input.tokenHash, input.tokenSealed, JSON.stringify(input.snapshot)],
      )
      if (!row) throw new Error('Share insert returned no row')
      return mapShare(row)
    },

    /** Active links to one conversation or report. */
    async listFor(workspaceId: string, kind: ShareKind, targetId: string): Promise<ShareRecord[]> {
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM app.share_links s LEFT JOIN app.users u ON u.id = s.created_by
         WHERE s.workspace_id = $1 AND s.kind = $2 AND s.target_id = $3 AND s.revoked_at IS NULL
         ORDER BY s.created_at DESC`,
        [workspaceId, kind, targetId],
      )
      return rows.map(mapShare)
    },

    /** Every active link of a workspace (admins review and revoke them). */
    async listActive(workspaceId: string, limit = 200): Promise<ShareRecord[]> {
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM app.share_links s LEFT JOIN app.users u ON u.id = s.created_by
         WHERE s.workspace_id = $1 AND s.revoked_at IS NULL
         ORDER BY s.created_at DESC LIMIT $2`,
        [workspaceId, limit],
      )
      return rows.map(mapShare)
    },

    async get(workspaceId: string, id: string): Promise<ShareRecord | null> {
      const [row] = await db.query(
        `SELECT ${COLUMNS} FROM app.share_links s LEFT JOIN app.users u ON u.id = s.created_by
         WHERE s.workspace_id = $1 AND s.id = $2 AND s.revoked_at IS NULL`,
        [workspaceId, id],
      )
      return row ? mapShare(row) : null
    },

    async revoke(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query(`UPDATE app.share_links SET revoked_at = now() WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id`, [workspaceId, id])
      return rows.length > 0
    },

    /**
     * The shared content behind a token, counting the view. Null when the link is unknown or
     * revoked, or when the conversation / report it points at has since been deleted.
     */
    async openByTokenHash(tokenHash: string): Promise<{ title: string; kind: ShareKind; workspaceName: string; createdAt: string; snapshot: SharedSnapshot } | null> {
      const [row] = await db.query(
        `UPDATE app.share_links s SET view_count = s.view_count + 1, last_viewed_at = now()
         FROM app.workspaces w
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND w.id = s.workspace_id
           AND CASE s.kind
                 WHEN 'conversation' THEN EXISTS (SELECT 1 FROM app.conversations c WHERE c.id = s.target_id AND c.workspace_id = s.workspace_id)
                 ELSE EXISTS (SELECT 1 FROM app.reports r WHERE r.id = s.target_id AND r.workspace_id = s.workspace_id)
               END
         RETURNING s.title, s.kind, s.created_at, s.snapshot, CASE WHEN w.personal_user_id IS NULL THEN w.name ELSE 'Personal workspace' END AS workspace_name`,
        [tokenHash],
      )
      if (!row) return null
      const snapshot = (typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot) as SharedSnapshot
      return {
        title: String(row.title),
        kind: row.kind === 'report' ? 'report' : 'conversation',
        workspaceName: String(row.workspace_name),
        createdAt: toIso(row.created_at),
        snapshot,
      }
    },
  }
}
