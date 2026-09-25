import type { EvalCase, EvalRunSummary, EvaluationScores, JobStatus, QualitySummary } from '@/lib/contracts'
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

function mapRun(row: Record<string, unknown>): EvalRunSummary {
  return {
    id: String(row.id),
    status: row.status as JobStatus,
    caseCount: toNumber(row.case_count),
    completedCount: toNumber(row.completed_count),
    averages: mapScores(row, 'avg_'),
    createdAt: toIso(row.created_at),
    finishedAt: row.finished_at ? toIso(row.finished_at) : null,
    error: row.error ? String(row.error) : null,
  }
}

const RUN_COLUMNS = `r.id, r.status, r.case_count, r.completed_count, r.created_at, r.finished_at, r.error,
  (SELECT avg(e.faithfulness) FROM app.evaluations e WHERE e.run_id = r.id) AS avg_faithfulness,
  (SELECT avg(e.answer_relevance) FROM app.evaluations e WHERE e.run_id = r.id) AS avg_answer_relevance,
  (SELECT avg(e.context_precision) FROM app.evaluations e WHERE e.run_id = r.id) AS avg_context_precision,
  (SELECT avg(e.context_recall) FROM app.evaluations e WHERE e.run_id = r.id) AS avg_context_recall`

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
      const [[totals], trendRows, flaggedRows, [lastRun]] = await Promise.all([
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
        db.query(`SELECT ${RUN_COLUMNS} FROM app.eval_runs r WHERE r.workspace_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [workspaceId]),
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
        lastBenchmark: lastRun ? mapRun(lastRun) : null,
      }
    },

    async cases(workspaceId: string): Promise<EvalCase[]> {
      const rows = await db.query(`SELECT id, question, reference_answer, collection_id, created_at FROM app.eval_cases WHERE workspace_id = $1 ORDER BY created_at`, [workspaceId])
      return rows.map((row) => ({
        id: String(row.id),
        question: String(row.question),
        referenceAnswer: String(row.reference_answer),
        collectionId: row.collection_id ? String(row.collection_id) : null,
        createdAt: toIso(row.created_at),
      }))
    },

    async caseCount(workspaceId: string): Promise<number> {
      const [row] = await db.query(`SELECT count(*)::int AS n FROM app.eval_cases WHERE workspace_id = $1`, [workspaceId])
      return toNumber(row?.n)
    },

    async addCase(input: { workspaceId: string; question: string; referenceAnswer: string; collectionId: string | null; createdBy: string }): Promise<EvalCase> {
      const [row] = await db.query(
        `INSERT INTO app.eval_cases (workspace_id, question, reference_answer, collection_id, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, question, reference_answer, collection_id, created_at`,
        [input.workspaceId, input.question, input.referenceAnswer, input.collectionId, input.createdBy],
      )
      if (!row) throw new Error('Eval case insert returned no row')
      return {
        id: String(row.id),
        question: String(row.question),
        referenceAnswer: String(row.reference_answer),
        collectionId: row.collection_id ? String(row.collection_id) : null,
        createdAt: toIso(row.created_at),
      }
    },

    async deleteCase(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.eval_cases WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId])
      return rows.length > 0
    },

    async createRun(workspaceId: string, createdBy: string, caseCount: number): Promise<EvalRunSummary> {
      const [row] = await db.query(
        `INSERT INTO app.eval_runs (workspace_id, created_by, case_count) VALUES ($1, $2, $3)
         RETURNING id, status, case_count, completed_count, created_at, finished_at, error`,
        [workspaceId, createdBy, caseCount],
      )
      if (!row) throw new Error('Eval run insert returned no row')
      return mapRun(row)
    },

    async runs(workspaceId: string, limit = 10): Promise<EvalRunSummary[]> {
      const rows = await db.query(`SELECT ${RUN_COLUMNS} FROM app.eval_runs r WHERE r.workspace_id = $1 ORDER BY r.created_at DESC LIMIT $2`, [workspaceId, limit])
      return rows.map(mapRun)
    },

    async runForJob(runId: string): Promise<{ id: string; workspaceId: string; createdBy: string | null } | null> {
      const [row] = await db.query<{ id: string; workspace_id: string; created_by: string | null }>(`SELECT id, workspace_id, created_by FROM app.eval_runs WHERE id = $1`, [runId])
      return row ? { id: String(row.id), workspaceId: String(row.workspace_id), createdBy: row.created_by ? String(row.created_by) : null } : null
    },

    async markRun(runId: string, status: JobStatus, error: string | null = null): Promise<void> {
      await db.query(`UPDATE app.eval_runs SET status = $2, error = $3, finished_at = CASE WHEN $2 IN ('completed', 'failed') THEN now() ELSE finished_at END WHERE id = $1`, [
        runId,
        status,
        error,
      ])
    },

    async incrementRunProgress(runId: string): Promise<void> {
      await db.query(`UPDATE app.eval_runs SET completed_count = completed_count + 1 WHERE id = $1`, [runId])
    },

    /** Cases already scored in a run (so a retried benchmark job resumes instead of starting over). */
    async scoredCaseIds(runId: string): Promise<Set<string>> {
      const rows = await db.query<{ case_id: string }>(`SELECT case_id FROM app.evaluations WHERE run_id = $1 AND case_id IS NOT NULL`, [runId])
      return new Set(rows.map((row) => String(row.case_id)))
    },
  }
}
