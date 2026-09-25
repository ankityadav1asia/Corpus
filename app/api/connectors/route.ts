import { CONNECTOR_PROVIDERS, type ConnectorsOverview } from '@/lib/contracts'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/** Available connectors, the caller's connected accounts (admins: everyone's), and synced sources. */
export const GET = workspaceRoute(async ({ access }) => {
  const services = getServices()
  const registry = services.connectors()
  const [connections, sources] = await Promise.all([
    services.repos.connectors.listConnections(access.workspaceId, access.userId, access.role === 'admin'),
    services.repos.connectors.listSources(access.workspaceId),
  ])
  return json<ConnectorsOverview>({
    providers: CONNECTOR_PROVIDERS.map((id) => ({ id, available: registry.get(id) !== null, reason: registry.unavailableReason(id) })),
    connections,
    sources,
  })
})
