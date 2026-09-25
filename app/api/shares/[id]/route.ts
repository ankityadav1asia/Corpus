import { idSchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { parseWith } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'
import { revokeShare } from '@/server/shares/service'

/** Turns a public link off (its creator or a workspace admin). */
export const DELETE = workspaceRoute<{ id: string }>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  await revokeShare(repos, access, id)
  await recordAudit(repos, access, 'share.revoked', { type: 'share', id }, {})
  return json({ ok: true })
})
