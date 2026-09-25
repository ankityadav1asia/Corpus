import { neon } from '@neondatabase/serverless'

import { createPgliteDb } from '@/server/db/pglite'

export type Row = Record<string, unknown>

export interface Query {
  text: string
  params?: readonly unknown[]
}

/**
 * The only way the app talks to Postgres. Every query is parameterised ($1, $2, …);
 * repositories never concatenate user input into SQL. Tests provide a PGlite-backed Db.
 */
export interface Db {
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>
  /** Runs the statements atomically (one round trip on Neon's HTTP driver). */
  transaction(queries: Query[]): Promise<Row[][]>
  /** Releases the database. Scripts call it when done: an open PGlite directory keeps Node running. */
  close(): Promise<void>
}

/** POSTGRES_URL=pglite:<directory> (or pglite:memory) runs an in-process database for local development. */
export function createDb(connectionString: string): Db {
  if (connectionString.startsWith('pglite:')) return createPgliteDb(connectionString.slice('pglite:'.length) || 'memory')
  return createNeonDb(connectionString)
}

export function createNeonDb(connectionString: string): Db {
  const sql = neon(connectionString)
  return {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []) {
      return (await sql(text, [...params])) as T[]
    },
    async transaction(queries: Query[]) {
      return (await sql.transaction(queries.map((q) => sql(q.text, [...(q.params ?? [])])))) as Row[][]
    },
    async close() {
      // HTTP queries hold no connection open.
    },
  }
}
