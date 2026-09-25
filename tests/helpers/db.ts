import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'

import type { Db, Query, Row } from '@/server/db/client'
import { runMigrations } from '@/server/db/migrate'

export interface TestDb {
  db: Db
  pg: PGlite
  close(): Promise<void>
}

/** Real Postgres (WASM) with pgvector, migrated with the production migrations. */
export async function createTestDb(options: { migrate?: boolean } = {}): Promise<TestDb> {
  const pg = new PGlite({ extensions: { vector } })
  const db: Db = {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []) {
      return (await pg.query<T>(text, [...params])).rows
    },
    async transaction(queries: Query[]) {
      return pg.transaction(async (tx) => {
        const results: Row[][] = []
        for (const query of queries) results.push((await tx.query<Row>(query.text, [...(query.params ?? [])])).rows)
        return results
      })
    },
    close: () => pg.close(),
  }
  if (options.migrate !== false) await runMigrations(db)
  return { db, pg, close: () => db.close() }
}
