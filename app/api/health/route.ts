import { json, publicRoute } from '@/server/http/route'
import { log } from '@/server/logger'
import { getServices } from '@/server/services'

/** Public liveness probe. Reports status only — no configuration or error details. */
export const GET = publicRoute(async () => {
  try {
    await getServices().db.query('SELECT 1')
    return json({ ok: true, database: 'up' })
  } catch (error) {
    log.warn('Health check: database unreachable', { error: String(error) })
    return json({ ok: false, database: 'down' }, { status: 503 })
  }
})
