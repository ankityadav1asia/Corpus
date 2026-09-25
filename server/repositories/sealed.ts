import type { Db } from '@/server/db/client'

/**
 * Every column holding a value sealed with server/security/secrets.ts. A fixed allowlist: table and
 * column names below are constants, never input, so interpolating them into SQL is safe.
 */
export const SEALED_COLUMNS = {
  connections: { table: 'app.connections', column: 'credentials' },
  integrations: { table: 'app.integrations', column: 'credentials' },
  shareTokens: { table: 'app.share_links', column: 'token_sealed' },
} as const

export type SealedKind = keyof typeof SEALED_COLUMNS

/** Bulk access to sealed values, for re-encrypting them after AUTH_SECRET is rotated. */
export function sealedValuesRepository(db: Db) {
  return {
    async list(kind: SealedKind): Promise<Array<{ id: string; value: string }>> {
      const { table, column } = SEALED_COLUMNS[kind]
      const rows = await db.query(`SELECT id, ${column} AS value FROM ${table} ORDER BY id`)
      return rows.map((row) => ({ id: String(row.id), value: String(row.value) }))
    },

    async update(kind: SealedKind, id: string, value: string): Promise<void> {
      const { table, column } = SEALED_COLUMNS[kind]
      await db.query(`UPDATE ${table} SET ${column} = $2 WHERE id = $1`, [id, value])
    },
  }
}
