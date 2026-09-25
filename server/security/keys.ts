/**
 * Secrets used to sign (sessions) and encrypt (third-party credentials, share tokens): a single
 * secret, or a key ring whose first entry is current and whose others are only accepted.
 * Edge-safe (no imports), so middleware can use it too.
 */
export type SecretKeys = string | readonly [string, ...string[]]

/** The secret new signatures and ciphertexts are made with. */
export function currentKey(keys: SecretKeys): string {
  return typeof keys === 'string' ? keys : keys[0]
}

/** Every secret that is still accepted, current first. */
export function acceptedKeys(keys: SecretKeys): readonly string[] {
  return typeof keys === 'string' ? [keys] : keys
}
