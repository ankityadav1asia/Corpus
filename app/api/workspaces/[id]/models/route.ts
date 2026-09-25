import type { ModelsStatus } from '@/lib/contracts'
import { getModelSummary } from '@/server/env'
import { json, workspaceParamRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/** Which models the server uses (names only) and how many passages still use an older embedding model. */
export const GET = workspaceParamRoute(async ({ access }) => {
  const services = getServices()
  let active: string | null = null
  try {
    active = services.ai().embeddingModel
  } catch {
    active = null // AI not configured
  }
  const counts = active ? await services.repos.chunks.embeddingStatus(access.workspaceId, active) : { total: 0, stale: 0 }
  const reembedding = await services.repos.jobs.hasActive('reembed_workspace', { workspaceId: access.workspaceId })
  return json<ModelsStatus>({ models: getModelSummary(), embeddings: { active, ...counts, reembedding } })
})
