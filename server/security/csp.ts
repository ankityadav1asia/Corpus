/**
 * Content Security Policy, built per request with a fresh nonce (middleware.ts). Scripts must come
 * from this origin or carry the nonce, so an injected inline script cannot run even if markup ever
 * slipped through. `img-src` / `connect-src` are locked to this origin so a prompt-injected answer
 * cannot exfiltrate data through image URLs or background requests. Edge-safe (no imports).
 */

/** 128 random bits, base64. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function contentSecurityPolicy(nonce: string, options: { development: boolean }): string {
  const { development } = options
  return [
    "default-src 'self'",
    // No 'unsafe-inline': Next.js adds the nonce to its own inline scripts. Dev tools need eval.
    `script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ''}`,
    // Inline style attributes (charts, layout) are harmless without script execution.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    // The PDF viewer's pdf.js worker is served from this origin.
    "worker-src 'self' blob:",
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ')
}
