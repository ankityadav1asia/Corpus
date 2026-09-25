const BASE = 'http://redirect.invalid'

/** A path the browser would read as another host: `//evil.com` or `/\evil.com`. */
const isProtocolRelative = (path: string) => path.startsWith('//') || path.startsWith('/\\')

/**
 * Returns `value` only if it is a same-origin relative path; otherwise `fallback`.
 * Blocks open redirects such as `//evil.com`, `/\evil.com` and absolute URLs, and checks the path
 * again after normalisation, because `/.//evil.com` or `/a/..//evil.com` normalise to `//evil.com`.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = '/'): string {
  if (typeof value !== 'string' || !value.startsWith('/') || isProtocolRelative(value) || value.includes('\\')) {
    return fallback
  }
  try {
    const url = new URL(value, BASE)
    if (url.origin !== BASE) return fallback
    const path = `${url.pathname}${url.search}${url.hash}`
    return isProtocolRelative(path) ? fallback : path
  } catch {
    return fallback
  }
}
