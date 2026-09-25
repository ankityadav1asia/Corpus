import { conversationsQuerySchema } from '@/lib/contracts'
import { readSearchParams } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/**
 * Conversations are created by the first chat message; this lists the caller's own threads in the
 * workspace (pinned first, then most recent). `?q=` searches titles and message text instead.
 */
export const GET = workspaceRoute(async ({ req, access }) => {
  const { q } = readSearchParams(req, conversationsQuerySchema)
  const { conversations } = getServices().repos
  return json({
    conversations: q ? await conversations.search(access.workspaceId, access.userId, q) : await conversations.list(access.workspaceId, access.userId),
  })
})
