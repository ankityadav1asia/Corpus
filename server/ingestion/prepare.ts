import 'server-only'

import type { AiProvider } from '@/server/ai/provider'
import { requireCollectionPermission, type WorkspaceAccess } from '@/server/auth/access'
import type { Repositories } from '@/server/repositories'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'

/**
 * Common gate for every ingest endpoint, run *before* any network fetch or parsing:
 * per-user rate limit → AI configured → caller is an Editor (or Admin) of the notebook.
 */
export async function prepareIngest(access: WorkspaceAccess, collectionId: string): Promise<{ repos: Repositories; ai: AiProvider }> {
  const services = getServices()
  await enforceRateLimit(services.repos, `ingest:user:${access.userId}`, RATE_LIMITS.ingest)
  const ai = services.ai()
  await requireCollectionPermission(services.repos, access, collectionId, 'collection.ingest')
  return { repos: services.repos, ai }
}
