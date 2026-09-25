import type { Db } from '@/server/db/client'
import { toNumber } from '@/server/repositories/sql'

export const JOB_TYPES = [
  'evaluate_answer',
  'run_benchmark',
  'generate_report',
  'ingest_document',
  'generate_image',
  'read_media',
  'reembed_workspace',
  'generate_audio',
  'generate_mindmap',
  'sync_connector',
  'answer_bot_message',
] as const
export type JobType = (typeof JOB_TYPES)[number]

/**
 * Attempts per job type. Retries back off 10s → 20s → 40s → … (server/jobs/runner.ts), so four
 * attempts span more than a minute — long enough for per-minute model quotas (429) to reset.
 */
export const JOB_ATTEMPTS: Record<JobType, number> = {
  evaluate_answer: 3,
  run_benchmark: 4,
  generate_report: 4,
  // Indexing resumes where it stopped, so extra attempts only cost time, never duplicate work.
  ingest_document: 6,
  generate_image: 3,
  // OCR and speech steps are stored as they finish, so retries resume too.
  read_media: 5,
  reembed_workspace: 6,
  generate_audio: 4,
  generate_mindmap: 3,
  sync_connector: 4,
  // Chat-app replies: a late answer is still useful, a very late one is not.
  answer_bot_message: 3,
}

export interface JobRecord {
  id: string
  type: JobType
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
}

/** A running job whose worker died is picked up again after this long. */
export const STALE_LOCK_SECONDS = 10 * 60

function asPayload(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

/**
 * Durable queue in Postgres. Any number of workers can call `claim` concurrently:
 * FOR UPDATE SKIP LOCKED hands each job to exactly one of them.
 */
export function jobsRepository(db: Db) {
  return {
    async enqueue(type: JobType, payload: Record<string, unknown>, options: { delaySeconds?: number; maxAttempts?: number } = {}): Promise<string> {
      const [row] = await db.query<{ id: string }>(
        `INSERT INTO app.jobs (type, payload, run_after, max_attempts)
         VALUES ($1, $2::jsonb, now() + make_interval(secs => $3::float8), $4)
         RETURNING id`,
        [type, JSON.stringify(payload), options.delaySeconds ?? 0, options.maxAttempts ?? 3],
      )
      if (!row) throw new Error('Job insert returned no row')
      return String(row.id)
    },

    /** Whether a queued or running job of `type` has a payload containing `match` (to avoid duplicates). */
    async hasActive(type: JobType, match: Record<string, string>): Promise<boolean> {
      const [row] = await db.query(`SELECT 1 FROM app.jobs WHERE type = $1 AND status IN ('queued', 'running') AND payload @> $2::jsonb LIMIT 1`, [type, JSON.stringify(match)])
      return Boolean(row)
    },

    async claim(types?: readonly JobType[]): Promise<JobRecord | null> {
      const [row] = await db.query(
        `UPDATE app.jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
         WHERE id = (
           SELECT id FROM app.jobs
           WHERE ((status = 'queued' AND run_after <= now())
                  OR (status = 'running' AND locked_at < now() - make_interval(secs => $1::float8) AND attempts < max_attempts))
             AND ($2::text[] IS NULL OR type = ANY($2::text[]))
           ORDER BY run_after
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING id, type, payload, attempts, max_attempts`,
        [STALE_LOCK_SECONDS, types ? [...types] : null],
      )
      if (!row) return null
      return {
        id: String(row.id),
        type: row.type as JobType,
        payload: asPayload(row.payload),
        attempts: toNumber(row.attempts),
        maxAttempts: toNumber(row.max_attempts),
      }
    },

    async complete(id: string): Promise<void> {
      await db.query(`UPDATE app.jobs SET status = 'completed', locked_at = NULL, last_error = NULL, updated_at = now() WHERE id = $1`, [id])
    },

    /**
     * Re-queues with a delay, or marks the job failed once it is out of attempts (or at once when
     * `permanent`: a retry could not succeed). Returns the new status.
     */
    async fail(id: string, error: string, retryDelaySeconds: number, permanent = false): Promise<'queued' | 'failed'> {
      const [row] = await db.query<{ status: 'queued' | 'failed' }>(
        `UPDATE app.jobs SET
           status = CASE WHEN $4::boolean OR attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
           run_after = now() + make_interval(secs => $3::float8),
           locked_at = NULL,
           last_error = left($2, 2000),
           updated_at = now()
         WHERE id = $1
         RETURNING status`,
        [id, error, retryDelaySeconds, permanent],
      )
      return row?.status === 'failed' ? 'failed' : 'queued'
    },

    async status(id: string): Promise<{ status: string; attempts: number; lastError: string | null } | null> {
      const [row] = await db.query(`SELECT status, attempts, last_error FROM app.jobs WHERE id = $1`, [id])
      return row ? { status: String(row.status), attempts: toNumber(row.attempts), lastError: row.last_error ? String(row.last_error) : null } : null
    },

    async purgeFinished(olderThanDays = 7): Promise<number> {
      const rows = await db.query(`DELETE FROM app.jobs WHERE status IN ('completed', 'failed') AND updated_at < now() - make_interval(days => $1::int) RETURNING id`, [
        olderThanDays,
      ])
      return rows.length
    },
  }
}
