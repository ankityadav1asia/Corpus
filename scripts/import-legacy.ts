/**
 * Imports data created by the previous version of this app into the new schema and assigns
 * it to one account. Legacy tables are read-only here; nothing is re-embedded.
 *   npm run db:import-legacy -- --email you@example.com
 */
import 'dotenv/config'

import { createDb } from '@/server/db/client'
import { importLegacyData } from '@/server/db/import-legacy'
import { getSchemaStatus } from '@/server/db/migrate'

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const email = argument('--email')?.trim().toLowerCase()
  if (!email || !email.includes('@')) throw new Error('Usage: npm run db:import-legacy -- --email you@example.com')
  const url = process.env.POSTGRES_URL?.trim()
  if (!url) throw new Error('POSTGRES_URL is not set.')

  const db = createDb(url)
  const result = await (async () => {
    if (!(await getSchemaStatus(db)).ready) throw new Error('Run `npm run db:migrate` first.')
    return importLegacyData(db, email)
  })().finally(() => db.close())
  console.log(`✓ Imported into ${email}:`)
  console.table(result)
  if (result.skippedChunks > 0) {
    console.log(`  ${result.skippedChunks} legacy chunks were skipped (empty text or not ${3072}-dim embeddings).`)
  }
}

main().catch((error) => {
  console.error('Legacy import failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
