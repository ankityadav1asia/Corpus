/**
 * A migrated PostgreSQL (PGlite + pgvector, in memory) on a TCP port, for the Go backend's
 * database tests and for running the Go backend locally without a database server.
 *   npm run db:pglite-server                # port 54329
 *   npm run db:pglite-server -- --port 6543
 * Prints `READY postgres://…` once the schema is migrated. Data is lost when it stops.
 */
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

import type { Db, Query, Row } from '@/server/db/client'
import { runMigrations } from '@/server/db/migrate'

const portArg = process.argv.indexOf('--port')
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 54329

async function main() {
  const pg = await PGlite.create({ extensions: { vector } })
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
  await runMigrations(db)

  const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' })
  await server.start()
  console.log(`READY postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`)

  async function stop() {
    await server.stop()
    await pg.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
