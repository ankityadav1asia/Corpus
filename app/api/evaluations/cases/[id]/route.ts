import { idSchema } from '@/lib/contracts'
import { requireWorkspacePermission } from '@/server/auth/access'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

export const DELETE = workspaceRoute<{ id: string }>(async ({ params, access }) => {
  requireWorkspacePermission(access, 'evaluation.manage')
  const id = parseWith(idSchema, params.id)
  if (!(await getServices().repos.evaluations.deleteCase(access.workspaceId, id))) throw Errors.notFound('Benchmark question')
  return json({ ok: true })
})
