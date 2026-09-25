/**
 * Applies pending schema migrations (server/db/migrations.ts). Safe to run repeatedly.
 *   npm run db:migrate
 */
import 'dotenv/config'

import { createDb } from '@/server/db/client'
import { runMigrations } from '@/server/db/migrate'

async function main() {
  const url = process.env.POSTGRES_URL?.trim()
  if (!url) throw new Error('POSTGRES_URL is not set. Copy .env.example to .env and fill it in.')
  const db = createDb(url)
  try {
    const { applied, version } = await runMigrations(db, (message) => console.log(`✓ ${message}`))
    console.log(applied.length ? `Database schema is now at version ${version}.` : `Database schema is already up to date (version ${version}).`)
  } finally {
    await db.close()
  }
}

main().catch((error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
