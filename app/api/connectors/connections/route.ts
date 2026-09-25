import { connectionCreateSchema, type ConnectionSummary } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireWorkspacePermission } from '@/server/auth/access'
import { describeGitHubToken } from '@/server/connectors/github'
import { describeNotionToken } from '@/server/connectors/notion'
import { withConnectorErrors } from '@/server/connectors/service'
import type { ConnectorContext } from '@/server/connectors/types'
import { getSecretKeys } from '@/server/env'
import { readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { sealSecret } from '@/server/security/secrets'
import { getServices } from '@/server/services'

/**
 * Connects a Notion integration or a GitHub account with a token (Editor). The token is checked
 * against the app, then stored encrypted; only its owner can browse or import through it.
 */
export const POST = workspaceRoute(async ({ req, access }) => {
  requireWorkspacePermission(access, 'connectors.use')
  const input = await readJson(req, connectionCreateSchema, 4 * 1024)
  const services = getServices()
  await enforceRateLimit(services.repos, `connectors:user:${access.userId}`, RATE_LIMITS.connectorSync)
  if (input.provider === 'notion' && !input.token) throw Errors.badRequest('Paste the Notion integration secret.')
  const credentials: Record<string, string> = input.token ? { token: input.token } : {}
  const context: ConnectorContext = { credentials, fetch, saveCredentials: async () => {} }
  const accountLabel = await withConnectorErrors(() => (input.provider === 'notion' ? describeNotionToken(context) : describeGitHubToken(context)))
  const connection = await services.repos.connectors.saveConnection({
    workspaceId: access.workspaceId,
    userId: access.userId,
    provider: input.provider,
    accountLabel,
    credentials: await sealSecret(JSON.stringify(context.credentials), getSecretKeys()),
  })
  await recordAudit(services.repos, access, 'connector.connected', { type: 'connection', id: connection.id }, { provider: input.provider, account: accountLabel })
  return json<{ connection: ConnectionSummary }>({ connection }, { status: 201 })
})
