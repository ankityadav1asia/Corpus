import { idSchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { parseWith } from '@/server/http/body'
import { json, workspaceParamRoute } from '@/server/http/route'
import { deleteIntegration } from '@/server/integrations/service'
import { getServices } from '@/server/services'

/** Disconnects a bot (admins). The platform's later requests to its endpoint get 404. */
export const DELETE = workspaceParamRoute<{ id: string; integrationId: string }>(async ({ params, access }) => {
  const { repos } = getServices()
  const id = parseWith(idSchema, params.integrationId)
  await deleteIntegration({ repos }, access, id)
  await recordAudit(repos, access, 'integration.removed', { type: 'integration', id }, {})
  return json({ ok: true })
})
