import 'server-only'

import type { ConnectorProvider } from '@/lib/contracts'
import type { WorkspaceAccess } from '@/server/auth/access'
import { openConnectionContext } from '@/server/connectors/sync'
import { ConnectorError, type Connector, type ConnectorContext } from '@/server/connectors/types'
import { getSecretKeys } from '@/server/env'
import { AppError, Errors } from '@/server/http/errors'
import type { ConnectionRecord } from '@/server/repositories/connectors'
import type { Services } from '@/server/services'

/** Connector failures as HTTP errors with messages safe to show. */
export function connectorHttpError(error: unknown): unknown {
  if (!(error instanceof ConnectorError)) return error
  if (error.auth) return new AppError(409, 'CONNECTOR_AUTH', error.message)
  if (error.retryable) return Errors.upstream(error.message)
  return Errors.badRequest(error.message)
}

export async function withConnectorErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw connectorHttpError(error)
  }
}

export function connectorFor(services: Services, provider: ConnectorProvider): Connector {
  const connector = services.connectors().get(provider)
  if (!connector) throw Errors.notConfigured(services.connectors().unavailableReason(provider) ?? 'This connector is not available on this server.')
  return connector
}

/** The caller's own connection (others' connections cannot be browsed or imported through). */
export async function ownConnection(services: Services, access: WorkspaceAccess, id: string): Promise<{ connection: ConnectionRecord; context: ConnectorContext }> {
  const connection = await services.repos.connectors.getConnection(access.workspaceId, id)
  if (!connection || connection.userId !== access.userId) throw Errors.notFound('Connection')
  const context = await withConnectorErrors(() => openConnectionContext({ repos: services.repos, secret: getSecretKeys() }, access.workspaceId, connection.id))
  return { connection, context }
}
