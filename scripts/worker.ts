/**
 * Processes background jobs (answer evaluation, benchmark runs, synthesis reports).
 * The web app already works through the queue right after each response; run this for steady
 * throughput, or on hosts where post-response work is not kept alive.
 *   npm run worker              keep polling (Ctrl+C to stop)
 *   npm run worker -- --once    drain the queue once, then exit
 */
import 'dotenv/config'

import { assertConfig } from '@/server/config-check'
import { runJobs } from '@/server/jobs/runner'
import { jobContextFrom } from '@/server/jobs/trigger'
import { getServices } from '@/server/services'

const IDLE_DELAY_MS = 5_000
const PURGE_EVERY_MS = 60 * 60 * 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  assertConfig('worker')
  const once = process.argv.includes('--once')
  const services = getServices()
  const context = jobContextFrom(services)
  let stopping = false
  const stop = () => {
    if (stopping) process.exit(1)
    stopping = true
    console.log('Stopping after the current job… (press Ctrl+C again to force)')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  console.log(once ? 'Draining the job queue…' : 'Worker started. Press Ctrl+C to stop.')
  const totals = { processed: 0, failed: 0 }
  let lastPurge = 0
  while (!stopping) {
    if (Date.now() - lastPurge > PURGE_EVERY_MS) {
      lastPurge = Date.now()
      const purged = await services.repos.jobs.purgeFinished(7).catch(() => 0)
      if (purged) console.log(`Removed ${purged} finished job(s) older than 7 days.`)
    }
    const result = await runJobs(context, { maxJobs: 10, timeBudgetMs: 120_000, shouldStop: () => stopping })
    totals.processed += result.processed
    totals.failed += result.failed
    if (result.processed || result.failed) {
      console.log(`✓ ${result.processed} job(s) done, ${result.failed} failed (will retry if attempts remain)`)
      continue
    }
    if (once) break
    await sleep(IDLE_DELAY_MS)
  }
  console.log(`Finished: ${totals.processed} done, ${totals.failed} failed.`)
  await services.db.close()
}

main().catch((error) => {
  console.error('Worker failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
