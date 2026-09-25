import type { Db } from '@/server/db/client'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '@/server/db/migrations'
import { pgErrorCode } from '@/server/http/errors'

const MIGRATION_LOCK_KEY = 727_274_001

export async function runMigrations(db: Db, onApplied: (message: string) => void = () => undefined) {
  await db.query(`CREATE SCHEMA IF NOT EXISTS app`)
  await db.query(`CREATE TABLE IF NOT EXISTS app.schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`)

  const rows = await db.query<{ version: number }>(`SELECT version FROM app.schema_migrations`)
  const applied = new Set(rows.map((row) => Number(row.version)))
  const newlyApplied: number[] = []

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    // Serialises concurrent runs; a second runner fails on the version PK and rolls back cleanly.
    await db.transaction([
      { text: `SELECT pg_advisory_xact_lock($1)`, params: [MIGRATION_LOCK_KEY] },
      ...migration.statements.map((text) => ({ text })),
      { text: `INSERT INTO app.schema_migrations (version, name) VALUES ($1, $2)`, params: [migration.version, migration.name] },
    ])
    newlyApplied.push(migration.version)
    onApplied(`Applied migration ${migration.version} (${migration.name})`)
  }

  return { applied: newlyApplied, version: LATEST_SCHEMA_VERSION }
}

/** 0 when the schema has never been migrated. Other database errors propagate. */
export async function getSchemaVersion(db: Db): Promise<number> {
  try {
    const [row] = await db.query<{ version: number | null }>(`SELECT max(version)::int AS version FROM app.schema_migrations`)
    return Number(row?.version ?? 0)
  } catch (error) {
    const code = pgErrorCode(error)
    if (code === '42P01' || code === '3F000') return 0 // undefined_table / invalid_schema_name
    throw error
  }
}

export interface SchemaStatus {
  /** Every migration of this build has been applied. */
  ready: boolean
  version: number
  expected: number
}

/** Where the database schema stands against this build (safe to call before any migration). */
export async function getSchemaStatus(db: Db): Promise<SchemaStatus> {
  const version = await getSchemaVersion(db)
  return { ready: version >= LATEST_SCHEMA_VERSION, version, expected: LATEST_SCHEMA_VERSION }
}
