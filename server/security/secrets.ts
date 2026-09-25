import { base64UrlDecode, base64UrlEncode } from '@/server/auth/session'
import { acceptedKeys, currentKey, type SecretKeys } from '@/server/security/keys'

/**
 * Encryption at rest for third-party credentials (connector and chat-app tokens) and share-link
 * tokens: AES-256-GCM with a key derived from AUTH_SECRET by HKDF, so a database dump alone does
 * not reveal anyone's Drive/Notion/GitHub/Slack access. New values are sealed with the current
 * secret; during a rotation values sealed with AUTH_SECRET_PREVIOUS still open, and
 * server/security/rotation.ts re-seals them with the current one.
 */

const VERSION = 'v1'
const encoder = new TextEncoder()
const keys = new Map<string, Promise<CryptoKey>>()

function deriveKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('corpus.connector-credentials'), info: encoder.encode(VERSION) },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
    })()
    keys.set(secret, key)
  }
  return key
}

export async function sealSecret(plaintext: string, secret: SecretKeys): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(currentKey(secret)), encoder.encode(plaintext))
  return `${VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`
}

export class SecretUnreadableError extends Error {
  constructor() {
    super('Stored credentials could not be decrypted')
    this.name = 'SecretUnreadableError'
  }
}

export async function openSecret(sealed: string, secret: SecretKeys): Promise<string> {
  const [version, iv, data] = sealed.split('.')
  const ivBytes = iv ? base64UrlDecode(iv) : null
  const dataBytes = data ? base64UrlDecode(data) : null
  if (version !== VERSION || !ivBytes || !dataBytes) throw new SecretUnreadableError()
  for (const key of acceptedKeys(secret)) {
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, await deriveKey(key), dataBytes)
      return new TextDecoder().decode(plaintext)
    } catch {
      // not sealed with this key: try the next accepted one
    }
  }
  throw new SecretUnreadableError()
}
