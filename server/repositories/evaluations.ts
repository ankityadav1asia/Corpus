import type { EvaluationScores, QualitySummary } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { toIso, toNullableNumber, toNumber } from '@/server/repositories/sql'

export interface EvaluationInput {
  workspaceId: string
  messageId?: string | null
  runId?: string | null
  caseId?: string | null
  question: string
  answer: string
  scores: EvaluationScores
  details: Record<string, unknown>
  model: string | null
}

/** Answers scoring below this on faithfulness or relevance are listed for review. */
export const FLAG_THRESHOLD = 0.5

const round = (value: number | null) => (value === null ? null : Math.round(value * 1000) / 1000)

function mapScores(row: Record<string, unknown>, prefix = ''): EvaluationScores {
  return {
    faithfulness: round(toNullableNumber(row[`${prefix}faithfulness`])),
    answerRelevance: round(toNullableNumber(row[`${prefix}answer_relevance`])),
    contextPrecision: round(toNullableNumber(row[`${prefix}context_precision`])),
    contextRecall: round(toNullableNumber(row[`${prefix}context_recall`])),
  }
}

export function evaluationsRepository(db: Db) {
  return {
    async save(input: EvaluationInput): Promise<void> {
      await db.query(
        `INSERT INTO app.evaluations (workspace_id, message_id, run_id, case_id, question, answer,
                                      faithfulness, answer_relevance, context_precision, context_recall, details, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         ON CONFLICT (message_id) DO UPDATE SET
           faithfulness = EXCLUDED.faithfulness, answer_relevance = EXCLUDED.answer_relevance,
           context_precision = EXCLUDED.context_precision, context_recall = EXCLUDED.context_recall,
           details = EXCLUDED.details, model = EXCLUDED.model, created_at = now()`,
        [
          input.workspaceId,
          input.messageId ?? null,
          input.runId ?? null,
          input.caseId ?? null,
          input.question.slice(0, 4000),
          input.answer.slice(0, 20_000),
          input.scores.faithfulness,
          input.scores.answerRelevance,
          input.scores.contextPrecision,
          input.scores.contextRecall,
          JSON.stringify(input.details),
          input.model,
        ],
      )
    },

    /** Live-answer quality for the last `days` days. `ownerId` restricts the review list to one user's answers. */
    async summary(workspaceId: string, options: { days: number; ownerId: string | null }): Promise<Omit<QualitySummary, 'feedback'>> {
      const [[totals], trendRows, flaggedRows] = await Promise.all([
        db.query(
          `SELECT count(*)::int AS evaluated, avg(faithfulness) AS faithfulness, avg(answer_relevance) AS answer_relevance,
                  avg(context_precision) AS context_precision,
                  (SELECT avg(context_recall) FROM app.evaluations WHERE workspace_id = $1 AND run_id IS NOT NULL
                     AND created_at > now() - make_interval(days => $2::int)) AS context_recall
           FROM app.evaluations
           WHERE workspace_id = $1 AND message_id IS NOT NULL AND created_at > now() - make_interval(days => $2::int)`,
          [workspaceId, options.days],
        ),
        db.query(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS count,
                  avg(faithfulness) AS faithfulness, avg(answer_relevance) AS answer_relevance, avg(context_precision) AS context_precision
           FROM app.evaluations
           WHERE workspace_id = $1 AND message_id IS NOT NULL AND created_at > now() - make_interval(days => $2::int)
           GROUP BY 1 ORDER BY 1`,
          [workspaceId, options.days],
        ),
        db.query(
          `SELECT e.id, e.question, e.faithfulness, e.answer_relevance, e.context_precision, e.context_recall, e.created_at, m.conversation_id
           FROM app.evaluations e
           JOIN app.messages m ON m.id = e.message_id
           JOIN app.conversations c ON c.id = m.conversation_id
           WHERE e.workspace_id = $1 AND ($2::uuid IS NULL OR c.owner_id = $2::uuid)
             AND (e.faithfulness < $3 OR e.answer_relevance < $3)
           ORDER BY e.created_at DESC
           LIMIT 20`,
          [workspaceId, options.ownerId, FLAG_THRESHOLD],
        ),
      ])
      return {
        days: options.days,
        evaluated: toNumber(totals?.evaluated),
        averages: totals ? mapScores(totals) : { faithfulness: null, answerRelevance: null, contextPrecision: null, contextRecall: null },
        trend: trendRows.map((row) => ({
          day: String(row.day),
          count: toNumber(row.count),
          faithfulness: round(toNullableNumber(row.faithfulness)),
          answerRelevance: round(toNullableNumber(row.answer_relevance)),
          contextPrecision: round(toNullableNumber(row.context_precision)),
        })),
        flagged: flaggedRows.map((row) => ({
          id: String(row.id),
          question: String(row.question),
          conversationId: row.conversation_id ? String(row.conversation_id) : null,
          scores: mapScores(row),
          createdAt: toIso(row.created_at),
        })),
      }
    },

  }
}
