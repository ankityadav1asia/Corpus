/** The envelope endpoint of a Sentry DSN (https://key@host[/prefix]/project), or null when it is not one. */
export function envelopeUrl(dsn: string): string | null {
  try {
    const url = new URL(dsn)
    const segments = url.pathname.split('/').filter(Boolean)
    const project = segments.pop()
    if (!project || !/^\d+$/.test(project) || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null
    return `${url.protocol}//${url.host}${segments.length ? `/${segments.join('/')}` : ''}/api/${project}/envelope/`
  } catch {
    return null
  }
}
