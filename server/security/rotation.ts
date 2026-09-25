import type { Repositories } from '@/server/repositories'
import { SEALED_COLUMNS, type SealedKind } from '@/server/repositories/sealed'
import { currentKey, type SecretKeys } from '@/server/security/keys'
import { SecretUnreadableError, openSecret, sealSecret } from '@/server/security/secrets'

export interface ResealReport {
  resealed: number
  /** Values none of the keys could open (sealed with a secret that is no longer configured). */
  unreadable: Array<{ kind: SealedKind; id: string }>
}

/**
 * Re-encrypts every sealed value with the current AUTH_SECRET, after a rotation
 * (AUTH_SECRET = new, AUTH_SECRET_PREVIOUS = old). Idempotent: running it again re-seals with the
 * same current key. Values nothing can open are reported, never deleted.
 */
export async function resealSecrets(repos: Pick<Repositories, 'sealed'>, keys: SecretKeys): Promise<ResealReport> {
  const report: ResealReport = { resealed: 0, unreadable: [] }
  const current = currentKey(keys)
  for (const kind of Object.keys(SEALED_COLUMNS) as SealedKind[]) {
    for (const row of await repos.sealed.list(kind)) {
      let plaintext: string
      try {
        plaintext = await openSecret(row.value, keys)
      } catch (error) {
        if (!(error instanceof SecretUnreadableError)) throw error
        report.unreadable.push({ kind, id: row.id })
        continue
      }
      await repos.sealed.update(kind, row.id, await sealSecret(plaintext, current))
      report.resealed++
    }
  }
  return report
}
