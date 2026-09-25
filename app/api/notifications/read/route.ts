import { notificationsReadSchema } from '@/lib/contracts'
import { readJson } from '@/server/http/body'
import { authedRoute, json } from '@/server/http/route'
import { getServices } from '@/server/services'

/** Marks some (`ids`) or all (`all: true`) of the caller's notifications as read. */
export const POST = authedRoute(async ({ req, user }) => {
  const input = await readJson(req, notificationsReadSchema, 8 * 1024)
  const updated = await getServices().repos.notifications.markRead(user.id, input.all ? 'all' : (input.ids ?? []))
  return json({ updated })
})
