import { authedRoute, json } from '@/server/http/route'
import { processJobsAfterResponse } from '@/server/jobs/trigger'

/**
 * Starts a pass of the background job runner after the response, for work queued by the Go API
 * (reports, mind maps), which cannot run TypeScript jobs itself. The browser calls it while it polls
 * for those results (hooks/use-api.ts), as the TypeScript routes used to on every poll. One runner
 * per instance, so repeated calls only keep it going.
 */
export const POST = authedRoute(async () => {
  processJobsAfterResponse()
  return json({ ok: true }, { status: 202 })
})
