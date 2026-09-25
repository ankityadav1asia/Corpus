import type { NotificationItem } from '@/lib/contracts'
import { authedRoute, json } from '@/server/http/route'
import { getServices } from '@/server/services'

/** The caller's latest notifications across their workspaces, with the unread count. */
export const GET = authedRoute(async ({ user }) => {
  return json<{ items: NotificationItem[]; unread: number }>(await getServices().repos.notifications.list(user.id, 30))
})
