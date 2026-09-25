import type { NotificationItem, NotificationKind, NotificationLink } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { toIso, toNumber } from '@/server/repositories/sql'

export interface NewNotification {
  userId: string
  workspaceId: string | null
  kind: NotificationKind
  title: string
  body?: string | null
  link?: NotificationLink | null
}

function asLink(value: unknown): NotificationLink | null {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  return parsed && typeof parsed === 'object' && 'tab' in parsed ? (parsed as NotificationLink) : null
}

/**
 * In-app notifications. Notifications from a workspace the person has since left are hidden,
 * so titles of documents or reports there are not shown to former members.
 */
export function notificationsRepository(db: Db) {
  const VISIBLE = `(n.workspace_id IS NULL OR EXISTS (SELECT 1 FROM app.workspace_members m WHERE m.workspace_id = n.workspace_id AND m.user_id = n.user_id))`

  return {
    async create(input: NewNotification): Promise<void> {
      await db.query(`INSERT INTO app.notifications (user_id, workspace_id, kind, title, body, link) VALUES ($1, $2, $3, left($4, 200), left($5, 500), $6::jsonb)`, [
        input.userId,
        input.workspaceId,
        input.kind,
        input.title,
        input.body ?? null,
        input.link ? JSON.stringify(input.link) : null,
      ])
    },

    async list(userId: string, limit = 30): Promise<{ items: NotificationItem[]; unread: number }> {
      const [items, [count]] = await Promise.all([
        db.query(
          `SELECT n.id, n.kind, n.title, n.body, n.link, n.workspace_id, w.name AS workspace_name, n.read_at, n.created_at
           FROM app.notifications n LEFT JOIN app.workspaces w ON w.id = n.workspace_id
           WHERE n.user_id = $1 AND ${VISIBLE}
           ORDER BY n.created_at DESC
           LIMIT $2`,
          [userId, limit],
        ),
        db.query(`SELECT count(*)::int AS n FROM app.notifications n WHERE n.user_id = $1 AND n.read_at IS NULL AND ${VISIBLE}`, [userId]),
      ])
      return {
        unread: toNumber(count?.n),
        items: items.map((row) => ({
          id: String(row.id),
          kind: row.kind as NotificationKind,
          title: String(row.title),
          body: row.body ? String(row.body) : null,
          link: asLink(row.link),
          workspaceId: row.workspace_id ? String(row.workspace_id) : null,
          workspaceName: row.workspace_name ? String(row.workspace_name) : null,
          readAt: row.read_at ? toIso(row.read_at) : null,
          createdAt: toIso(row.created_at),
        })),
      }
    },

    async markRead(userId: string, ids: readonly string[] | 'all'): Promise<number> {
      const rows =
        ids === 'all'
          ? await db.query(`UPDATE app.notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING id`, [userId])
          : await db.query(`UPDATE app.notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::uuid[]) RETURNING id`, [userId, [...ids]])
      return rows.length
    },

    async purgeOlderThan(days: number): Promise<number> {
      const rows = await db.query(`DELETE FROM app.notifications WHERE created_at < now() - make_interval(days => $1::int) RETURNING id`, [days])
      return rows.length
    },
  }
}
