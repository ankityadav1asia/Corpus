import type { Db } from '@/server/db/client'
import { toIso } from '@/server/repositories/sql'

export interface SessionRecord {
  id: string
  userId: string
  createdAt: string
  expiresAt: string
  userAgent: string | null
}

/** Server-side sessions: the registry that makes signing out (and signing out everywhere) real. */
export function sessionsRepository(db: Db) {
  return {
    async create(input: { userId: string; expiresAt: Date; userAgent: string | null }): Promise<SessionRecord> {
      const [row] = await db.query(
        `INSERT INTO app.sessions (user_id, expires_at, user_agent) VALUES ($1, $2, $3)
         RETURNING id, user_id, created_at, expires_at, user_agent`,
        [input.userId, input.expiresAt.toISOString(), input.userAgent ? input.userAgent.slice(0, 300) : null],
      )
      if (!row) throw new Error('Session insert returned no row')
      return {
        id: String(row.id),
        userId: String(row.user_id),
        createdAt: toIso(row.created_at),
        expiresAt: toIso(row.expires_at),
        userAgent: row.user_agent ? String(row.user_agent) : null,
      }
    },

    /** True while the session belongs to the user, has not been revoked and has not expired. */
    async isActive(id: string, userId: string): Promise<boolean> {
      const rows = await db.query(`SELECT 1 FROM app.sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`, [id, userId])
      return rows.length > 0
    },

    async revoke(id: string, userId: string): Promise<boolean> {
      const rows = await db.query(`UPDATE app.sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`, [id, userId])
      return rows.length > 0
    },

    /** Ends every session of a user (sign out everywhere); returns how many were active. */
    async revokeAll(userId: string): Promise<number> {
      const rows = await db.query(`UPDATE app.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [userId])
      return rows.length
    },

    /** Housekeeping at sign-in: drops the user's expired and long-revoked sessions. */
    async purgeExpired(userId: string): Promise<void> {
      await db.query(`DELETE FROM app.sessions WHERE user_id = $1 AND (expires_at < now() OR revoked_at < now() - interval '1 day')`, [userId])
    },
  }
}
