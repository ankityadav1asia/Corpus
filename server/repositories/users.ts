import type { SessionUser } from '@/lib/contracts'
import type { Db } from '@/server/db/client'

interface UserRow extends Record<string, unknown> {
  id: string
  email: string
  name: string | null
  created: boolean
}

export function usersRepository(db: Db) {
  return {
    /** Creates the user on first sign-in; identities are keyed by verified email. */
    async upsertOnLogin(email: string, name: string | null): Promise<{ user: SessionUser; created: boolean }> {
      const [row] = await db.query<UserRow>(
        `INSERT INTO app.users (email, name, last_login_at)
         VALUES ($1, $2, now())
         ON CONFLICT (email) DO UPDATE
           SET last_login_at = now(), name = COALESCE(EXCLUDED.name, app.users.name)
         RETURNING id, email, name, (xmax = 0) AS created`,
        [email.trim().toLowerCase(), name?.trim() || null],
      )
      if (!row) throw new Error('User upsert returned no row')
      return { user: { id: row.id, email: row.email, name: row.name }, created: Boolean(row.created) }
    },

    async findById(id: string): Promise<SessionUser | null> {
      const [row] = await db.query<UserRow>(`SELECT id, email, name FROM app.users WHERE id = $1`, [id])
      return row ? { id: row.id, email: row.email, name: row.name } : null
    },
  }
}
