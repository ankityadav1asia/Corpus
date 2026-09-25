import type { PGlite } from '@electric-sql/pglite'

import type { Db, Query, Row } from '@/server/db/client'

/**
 * Local development without a database server: POSTGRES_URL=pglite:./.data/pglite (or pglite:memory).
 * Postgres + pgvector compiled to WASM, running inside the Node process — the same engine the test
 * suite uses. Only one process can open a data directory at a time. Not meant for production.
 *
 * The package is a devDependency, loaded lazily and kept out of the Next.js bundle
 * (serverExternalPackages), so production deployments never load it.
 */
const store = globalThis as typeof globalThis & { __corpusPglite?: Map<string, Promise<PGlite>> }
// Shared across hot reloads: two instances on one directory would corrupt it.
const instances = (store.__corpusPglite ??= new Map())

function open(location: string): Promise<PGlite> {
  let instance = instances.get(location)
  if (!instance) {
    instance = (async () => {
      const [{ PGlite }, { vector }, { mkdir }] = await Promise.all([import('@electric-sql/pglite'), import('@electric-sql/pglite-pgvector'), import('node:fs/promises')])
      if (location === 'memory') return PGlite.create({ extensions: { vector } })
      await mkdir(location, { recursive: true })
      return PGlite.create(location, { extensions: { vector } })
    })()
    instances.set(location, instance)
  }
  return instance
}

export function createPgliteDb(location: string): Db {
  return {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []) {
      return (await (await open(location)).query<T>(text, [...params])).rows
    },
    async transaction(queries: Query[]) {
      const pg = await open(location)
      return pg.transaction(async (tx) => {
        const results: Row[][] = []
        for (const query of queries) results.push((await tx.query<Row>(query.text, [...(query.params ?? [])])).rows)
        return results
      })
    },
    async close() {
      const instance = instances.get(location)
      if (!instance) return
      instances.delete(location)
      await (await instance).close()
    },
  }
}
