import { z } from 'zod'

import type { QualitySummary } from '@/lib/contracts'
import { readSearchParams } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

const summaryQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) })

/**
 * Answer quality for the workspace: faithfulness, answer relevance and context precision of live
 * answers, context recall from benchmark runs, and readers' thumbs up / down. Admins review
 * everyone's low-scoring answers and feedback; other members see only their own.
 */
export const GET = workspaceRoute(async ({ req, access }) => {
  const { days } = readSearchParams(req, summaryQuery)
  const { repos } = getServices()
  const own = access.role === 'admin' ? null : access.userId
  const [summary, feedback] = await Promise.all([
    repos.evaluations.summary(access.workspaceId, { days, ownerId: own }),
    repos.feedback.summary(access.workspaceId, { days, userId: own }),
  ])
  return json<QualitySummary>({ ...summary, feedback })
})
