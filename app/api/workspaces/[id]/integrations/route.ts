import { integrationCreateSchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { getAppOrigin, getSecretKeys } from '@/server/env'
import { readJson } from '@/server/http/body'
import { json, workspaceParamRoute } from '@/server/http/route'
import { createIntegration, listIntegrations } from '@/server/integrations/service'
import { getServices } from '@/server/services'

/** Slack / Microsoft Teams bots of this workspace (admins), with the endpoint each platform must call. */
export const GET = workspaceParamRoute(async ({ req, access }) => {
  const integrations = await listIntegrations({ repos: getServices().repos, secret: getSecretKeys() }, access, getAppOrigin(req.url))
  return json({ integrations })
})

/** Connects a bot after checking its credentials with Slack / Microsoft (admins). */
export const POST = workspaceParamRoute(async ({ req, access }) => {
  const services = getServices()
  const input = await readJson(req, integrationCreateSchema, 8 * 1024)
  const integration = await createIntegration({ repos: services.repos, fetch: services.fetch?.() ?? fetch, secret: getSecretKeys() }, access, input, getAppOrigin(req.url))
  await recordAudit(services.repos, access, 'integration.added', { type: 'integration', id: integration.id }, { provider: integration.provider, name: integration.name })
  return json({ integration }, { status: 201 })
})
