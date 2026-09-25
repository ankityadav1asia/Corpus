import { idSchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { requireOwnerOrAdmin } from '@/server/auth/access'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/**
 * Disconnects an account (its owner, or a workspace admin). Sources synced through it are removed;
 * the documents they imported stay in their notebooks as ordinary sources.
 */
export const DELETE = workspaceRoute<{ id: string }>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  const connection = await repos.connectors.getConnection(access.workspaceId, id)
  if (!connection) throw Errors.notFound('Connection')
  requireOwnerOrAdmin(access, connection.userId, 'disconnect this account')
  await repos.connectors.deleteConnection(access.workspaceId, id)
  await recordAudit(repos, access, 'connector.disconnected', { type: 'connection', id }, { provider: connection.provider, account: connection.accountLabel })
  return json({ ok: true })
})
