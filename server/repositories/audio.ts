import type { AudioFormat, AudioLanguage, AudioLength } from '@/lib/constants'
import type { AudioDetail, AudioSegment, AudioSummary, JobStatus, StudioSource } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { asJsonArray, asUuidArray, joinBase64Parts, toBase64, toIso, toNullableNumber, toNumber } from '@/server/repositories/sql'

/** A line of the stored script (before timing is known). */
export interface ScriptLine {
  speaker: 0 | 1
  text: string
}

export interface AudioJob {
  id: string
  workspaceId: string
  createdBy: string | null
  title: string
  format: AudioFormat
  length: AudioLength
  language: AudioLanguage
  focus: string | null
  collectionIds: string[]
  documentIds: string[]
  /** null until the script has been written. */
  script: ScriptLine[] | null
  sources: StudioSource[]
}

const SUMMARY_COLUMNS = `a.id, a.title, a.format, a.length, a.language, a.status, a.progress, a.duration_ms, a.created_at, a.completed_at, u.email AS created_by_email`

function mapSummary(row: Record<string, unknown>): AudioSummary {
  const duration = toNullableNumber(row.duration_ms)
  return {
    id: String(row.id),
    title: String(row.title),
    format: row.format as AudioFormat,
    length: row.length as AudioLength,
    language: row.language as AudioLanguage,
    status: row.status as JobStatus,
    progress: row.progress ? String(row.progress) : null,
    durationSeconds: duration === null ? null : Math.round(duration / 100) / 10,
    createdByEmail: row.created_by_email ? String(row.created_by_email) : null,
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
  }
}

export function audioRepository(db: Db) {
  return {
    async create(input: Omit<AudioJob, 'id' | 'script' | 'sources'>): Promise<AudioSummary> {
      const [row] = await db.query(
        `WITH a AS (
           INSERT INTO app.audio_overviews (workspace_id, created_by, title, format, length, language, focus, collection_ids, document_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9::uuid[])
           RETURNING *
         )
         SELECT ${SUMMARY_COLUMNS} FROM a LEFT JOIN app.users u ON u.id = a.created_by`,
        [input.workspaceId, input.createdBy, input.title, input.format, input.length, input.language, input.focus, input.collectionIds, input.documentIds],
      )
      if (!row) throw new Error('Audio overview insert returned no row')
      return mapSummary(row)
    },

    async list(workspaceId: string, limit = 100): Promise<AudioSummary[]> {
      const rows = await db.query(
        `SELECT ${SUMMARY_COLUMNS} FROM app.audio_overviews a LEFT JOIN app.users u ON u.id = a.created_by
         WHERE a.workspace_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
        [workspaceId, limit],
      )
      return rows.map(mapSummary)
    },

    async count(workspaceId: string): Promise<number> {
      const [row] = await db.query(`SELECT count(*)::int AS n FROM app.audio_overviews WHERE workspace_id = $1`, [workspaceId])
      return toNumber(row?.n)
    },

    async get(workspaceId: string, id: string): Promise<(AudioDetail & { createdBy: string | null }) | null> {
      const [row] = await db.query(
        `SELECT ${SUMMARY_COLUMNS}, a.focus, a.collection_ids, a.document_ids, a.transcript, a.sources, a.voices, a.model, a.byte_size, a.error, a.created_by
         FROM app.audio_overviews a LEFT JOIN app.users u ON u.id = a.created_by
         WHERE a.id = $1 AND a.workspace_id = $2`,
        [id, workspaceId],
      )
      if (!row) return null
      return {
        ...mapSummary(row),
        focus: row.focus ? String(row.focus) : null,
        collectionIds: asUuidArray(row.collection_ids),
        documentIds: asUuidArray(row.document_ids),
        transcript: asJsonArray<AudioSegment>(row.transcript),
        sources: asJsonArray<StudioSource>(row.sources),
        voices: asUuidArray(row.voices),
        model: row.model ? String(row.model) : null,
        byteSize: toNullableNumber(row.byte_size),
        error: row.error ? String(row.error) : null,
        createdBy: row.created_by ? String(row.created_by) : null,
      }
    },

    async forJob(id: string): Promise<AudioJob | null> {
      const [row] = await db.query(
        `SELECT id, workspace_id, created_by, title, format, length, language, focus, collection_ids, document_ids, script, sources
         FROM app.audio_overviews WHERE id = $1 AND status IN ('queued', 'running')`,
        [id],
      )
      if (!row) return null
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        createdBy: row.created_by ? String(row.created_by) : null,
        title: String(row.title),
        format: row.format as AudioFormat,
        length: row.length as AudioLength,
        language: row.language as AudioLanguage,
        focus: row.focus ? String(row.focus) : null,
        collectionIds: asUuidArray(row.collection_ids),
        documentIds: asUuidArray(row.document_ids),
        script: row.script === null || row.script === undefined ? null : asJsonArray<ScriptLine>(row.script),
        sources: asJsonArray<StudioSource>(row.sources),
      }
    },

    async setProgress(id: string, status: JobStatus, progress: string | null): Promise<void> {
      await db.query(`UPDATE app.audio_overviews SET status = $2, progress = $3 WHERE id = $1 AND status IN ('queued', 'running')`, [id, status, progress])
    },

    /** The written script (the recording then proceeds segment by segment). */
    async saveScript(id: string, input: { title: string; script: ScriptLine[]; sources: StudioSource[]; voices: readonly string[]; model: string }): Promise<void> {
      await db.query(`UPDATE app.audio_overviews SET title = $2, script = $3::jsonb, sources = $4::jsonb, voices = $5::text[], model = $6 WHERE id = $1`, [
        id,
        input.title,
        JSON.stringify(input.script),
        JSON.stringify(input.sources),
        [...input.voices],
        input.model,
      ])
    },

    /** Recorded segments so far (without audio data). */
    async segments(id: string): Promise<Array<{ idx: number; durationMs: number; byteSize: number }>> {
      const rows = await db.query(`SELECT idx, duration_ms, octet_length(data) AS bytes FROM app.audio_segments WHERE audio_id = $1 ORDER BY idx`, [id])
      return rows.map((row) => ({ idx: toNumber(row.idx), durationMs: toNumber(row.duration_ms), byteSize: toNumber(row.bytes) }))
    },

    async addSegment(id: string, idx: number, data: Uint8Array, durationMs: number): Promise<void> {
      await db.query(
        `INSERT INTO app.audio_segments (audio_id, idx, data, duration_ms) VALUES ($1, $2, decode($3, 'base64'), $4)
         ON CONFLICT (audio_id, idx) DO UPDATE SET data = excluded.data, duration_ms = excluded.duration_ms`,
        [id, idx, toBase64(data), Math.round(durationMs)],
      )
    },

    async complete(id: string, result: { transcript: AudioSegment[]; durationMs: number; byteSize: number }): Promise<void> {
      await db.query(
        `UPDATE app.audio_overviews SET status = 'completed', progress = NULL, error = NULL, transcript = $2::jsonb, duration_ms = $3, byte_size = $4, completed_at = now()
         WHERE id = $1`,
        [id, JSON.stringify(result.transcript), Math.round(result.durationMs), result.byteSize],
      )
    },

    async fail(id: string, error: string): Promise<void> {
      await db.query(`UPDATE app.audio_overviews SET status = 'failed', progress = NULL, error = left($2, 500), completed_at = now() WHERE id = $1`, [id, error])
    },

    async delete(workspaceId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.audio_overviews WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, workspaceId])
      return rows.length > 0
    },

    /** The finished recording: its segments back to back (MP3 frames concatenate cleanly). */
    async file(id: string): Promise<{ workspaceId: string; title: string; data: Uint8Array } | null> {
      const [row] = await db.query(`SELECT workspace_id, title FROM app.audio_overviews WHERE id = $1 AND status = 'completed'`, [id])
      if (!row) return null
      const parts = await db.query(`SELECT encode(data, 'base64') AS data FROM app.audio_segments WHERE audio_id = $1 ORDER BY idx`, [id])
      return { workspaceId: String(row.workspace_id), title: String(row.title), data: joinBase64Parts(parts) }
    },
  }
}
