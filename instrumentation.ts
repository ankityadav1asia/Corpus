/**
 * Runs once when a server instance starts. In production it refuses to start with a missing or
 * unsafe configuration (server/config-check.ts), so a bad deploy fails its health check with a
 * clear log line instead of failing on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { assertConfig } = await import('@/server/config-check')
  assertConfig('web server')
}
