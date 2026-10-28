/**
 * Writes backend/auth/testdata/tokens.json: session cookies signed by the Next.js app, which the Go
 * backend's token tests must accept (or reject) exactly as the TypeScript code does.
 *   npm run go:fixtures
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createSessionToken } from '@/server/auth/session'

const FILE = 'backend/auth/testdata/tokens.json'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const secret = 'f'.repeat(48)
const nowMs = Date.UTC(2026, 9, 1, 12, 0, 0)
const alice = { id: id(9001), user: { id: id(9002), email: 'alice@example.com', name: 'Alice' } }
const guest = { id: id(9003), user: { id: id(9004), email: 'guest-0123456789abcdef@demo.invalid', name: null } }

async function main() {
  const tokens = {
    generatedBy: 'scripts/go-fixtures.ts',
    secret,
    nowMs: nowMs + 3_600_000,
    valid: await createSessionToken(alice, secret, nowMs),
    guest: await createSessionToken(guest, secret, nowMs),
    expired: await createSessionToken(alice, secret, nowMs - 8 * 24 * 3_600_000),
    foreign: await createSessionToken(alice, 'g'.repeat(48), nowMs),
  }
  const target = path.join(process.cwd(), FILE)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(tokens, null, 1)}\n`)
  console.log(`✓ ${FILE}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
