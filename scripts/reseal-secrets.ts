/**
 * Re-encrypts stored credentials and share tokens with the current AUTH_SECRET after a rotation.
 * Set AUTH_SECRET to the new secret and AUTH_SECRET_PREVIOUS to the old one, then run:
 *   npm run secrets:reseal
 * See docs/DEPLOYMENT.md → "Rotating AUTH_SECRET".
 */
import 'dotenv/config'

import { createDb } from '@/server/db/client'
import { getCoreEnv, getSecretKeys } from '@/server/env'
import { createRepositories } from '@/server/repositories'
import { resealSecrets } from '@/server/security/rotation'

async function main() {
  const keys = getSecretKeys()
  const db = createDb(getCoreEnv().POSTGRES_URL)
  const report = await resealSecrets(createRepositories(db), keys).finally(() => db.close())
  console.log(`Re-sealed ${report.resealed} value(s) with the current AUTH_SECRET.`)
  if (report.unreadable.length > 0) {
    console.warn(`${report.unreadable.length} value(s) could not be opened with the configured secrets (their owners must reconnect):`)
    for (const item of report.unreadable) console.warn(`  ${item.kind} ${item.id}`)
  }
  if (typeof keys !== 'string' && keys.length > 1) {
    console.log('Keep AUTH_SECRET_PREVIOUS for 7 more days (existing sessions), then remove it.')
  }
}

main().catch((error) => {
  console.error('Re-sealing failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
