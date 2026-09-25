import type { QualitySummary } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { toIso, toNumber } from '@/server/repositories/sql'

export interface FeedbackInput {
  messageId: string
  userId: string
  workspaceId: string
  rating: 1 | -1
  comment: string | null
}

/** Thumbs up / down on answers — one rating per person per answer. */
export function feedbackRepository(db: Db) {
  return {
    async set(input: FeedbackInput): Promise<void> {
      await db.query(
        `INSERT INTO app.message_feedback (message_id, user_id, workspace_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (message_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()`,
        [input.messageId, input.userId, input.workspaceId, input.rating, input.comment],
      )
    },

    async remove(messageId: string, userId: string): Promise<void> {
      await db.query(`DELETE FROM app.message_feedback WHERE message_id = $1 AND user_id = $2`, [messageId, userId])
    },

    /** Counts for the period and the latest ratings; `userId` restricts both to one person's feedback. */
    async summary(workspaceId: string, options: { days: number; userId: string | null }): Promise<QualitySummary['feedback']> {
      const params = [workspaceId, options.days, options.userId]
      const scope = `f.workspace_id = $1 AND f.updated_at > now() - make_interval(days => $2::int) AND ($3::uuid IS NULL OR f.user_id = $3::uuid)`
      const [[totals], recent] = await Promise.all([
        db.query(
          `SELECT count(*) FILTER (WHERE f.rating = 1)::int AS positive, count(*) FILTER (WHERE f.rating = -1)::int AS negative
           FROM app.message_feedback f WHERE ${scope}`,
          params,
        ),
        db.query(
          `SELECT f.message_id, f.rating, f.comment, f.updated_at, u.email,
                  (SELECT q.content FROM app.messages a JOIN app.messages q ON q.conversation_id = a.conversation_id AND q.seq < a.seq AND q.role = 'user'
                   WHERE a.id = f.message_id ORDER BY q.seq DESC LIMIT 1) AS question
           FROM app.message_feedback f LEFT JOIN app.users u ON u.id = f.user_id
           WHERE ${scope}
           ORDER BY (f.rating = -1) DESC, f.updated_at DESC
           LIMIT 20`,
          params,
        ),
      ])
      return {
        positive: toNumber(totals?.positive),
        negative: toNumber(totals?.negative),
        recent: recent.map((row) => ({
          messageId: String(row.message_id),
          question: row.question ? String(row.question) : null,
          rating: toNumber(row.rating) === 1 ? 1 : -1,
          comment: row.comment ? String(row.comment) : null,
          userEmail: row.email ? String(row.email) : null,
          createdAt: toIso(row.updated_at),
        })),
      }
    },
  }
}
