import 'server-only'

import type { SessionUser, StatsResponse } from '@/lib/contracts'
import { getSchemaStatus } from '@/server/db/migrate'
import { getFeatureFlags } from '@/server/env'
import type { Services } from '@/server/services'

type Deps = Pick<Services, 'db' | 'repos'>

const NO_TOTALS: StatsResponse['totals'] = { collections: 0, documents: 0, chunks: 0 }

/** Totals of a workspace the user belongs to; zeros for any other id (never reveals it exists). */
async function workspaceTotals(services: Deps, userId: string, workspaceId: string | null): Promise<StatsResponse['totals']> {
  if (!workspaceId || !(await services.repos.workspaces.membership(workspaceId, userId))) return NO_TOTALS
  return services.repos.documents.totals(workspaceId)
}

/**
 * Overview for the signed-in user: schema state, configured features (names only, never secret
 * values) and the requested workspace's totals. Works before migrations.
 */
export async function getOverview(services: Deps, user: SessionUser, workspaceId: string | null): Promise<StatsResponse> {
  const schema = await getSchemaStatus(services.db)
  const totals = schema.ready ? await workspaceTotals(services, user.id, workspaceId) : NO_TOTALS
  return { user, schema, features: getFeatureFlags(), totals }
}
