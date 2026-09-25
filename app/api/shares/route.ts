import { shareCreateSchema, shareQuerySchema } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { readJson, readSearchParams } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { getAppOrigin, getSecretKeys } from '@/server/env'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'
import { createShare, listShares } from '@/server/shares/service'

/** Active public links to one of your conversations, or to a report in this workspace. */
export const GET = workspaceRoute(async ({ req, access }) => {
  const query = readSearchParams(req, shareQuerySchema)
  const links = await listShares(getServices().repos, access, query, getAppOrigin(req.url), getSecretKeys())
  return json({ links })
})

/** Creates a read-only public link (Editor and above). The content is a snapshot of it right now. */
export const POST = workspaceRoute(async ({ req, access }) => {
  const input = await readJson(req, shareCreateSchema, 4 * 1024)
  const { repos } = getServices()
  await enforceRateLimit(repos, `shares:user:${access.userId}`, RATE_LIMITS.shares)
  const link = await createShare(repos, access, input, getAppOrigin(req.url), getSecretKeys())
  await recordAudit(repos, access, 'share.created', { type: 'share', id: link.id }, { title: link.title, kind: input.kind, targetId: input.id })
  return json({ link }, { status: 201 })
})
