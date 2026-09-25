import type { StatsResponse } from '@/lib/contracts'
import { authedRoute, json, requestedWorkspaceId } from '@/server/http/route'
import { getServices } from '@/server/services'
import { getOverview } from '@/server/workspaces/overview'

/** Schema state, configured features and the active workspace's totals (see getOverview). */
export const GET = authedRoute(async ({ req, user }) => json<StatsResponse>(await getOverview(getServices(), user, requestedWorkspaceId(req))))
