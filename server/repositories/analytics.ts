import type { ChatMode } from '@/lib/constants'
import type { AnalyticsResponse, QueryStatus } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { toIso, toNullableNumber, toNumber } from '@/server/repositories/sql'

export interface QueryLogInput {
  workspaceId: string
  ownerId: string
  collectionId: string | null
  mode: ChatMode
  query: string
  latencyMs: number
  chunksRetrieved: number
  status: QueryStatus
}

function asStatus(value: unknown): QueryStatus {
  return value === 'error' || value === 'insufficient_context' ? value : 'ok'
}

export function analyticsRepository(db: Db) {
  return {
    async log(entry: QueryLogInput): Promise<void> {
      await db.query(
        `INSERT INTO app.query_logs (workspace_id, owner_id, collection_id, mode, query, latency_ms, chunks_retrieved, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.workspaceId,
          entry.ownerId,
          entry.collectionId,
          entry.mode,
          entry.query.slice(0, 500),
          Math.max(0, Math.round(entry.latencyMs)),
          entry.chunksRetrieved,
          entry.status,
        ],
      )
    },

    /** The caller's own queries, or (for workspace admins) everyone's in the workspace. */
    async summary(scope: { workspaceId: string; ownerId: string | null }): Promise<AnalyticsResponse> {
      const params: unknown[] = [scope.workspaceId]
      let where = 'workspace_id = $1'
      if (scope.ownerId) {
        params.push(scope.ownerId)
        where += ' AND owner_id = $2'
      }
      const [[totals], modeRows, recentRows] = await Promise.all([
        db.query(
          `SELECT count(*)::int AS queries,
                  count(*) FILTER (WHERE status = 'error')::int AS errors,
                  count(*) FILTER (WHERE status = 'insufficient_context')::int AS insufficient,
                  round(avg(latency_ms) FILTER (WHERE status = 'ok'))::int AS avg_latency,
                  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'ok'))::int AS p95_latency
           FROM app.query_logs WHERE ${where}`,
          params,
        ),
        db.query(`SELECT mode, count(*)::int AS count FROM app.query_logs WHERE ${where} GROUP BY mode`, params),
        db.query(
          `SELECT id, query, mode, collection_id, latency_ms, chunks_retrieved, status, created_at
           FROM app.query_logs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 20`,
          params,
        ),
      ])

      const byMode: AnalyticsResponse['byMode'] = { standard: 0, deep: 0 }
      for (const row of modeRows) {
        if (row.mode === 'standard' || row.mode === 'deep') byMode[row.mode] = toNumber(row.count)
      }

      return {
        scope: scope.ownerId ? 'me' : 'workspace',
        totals: {
          queries: toNumber(totals?.queries),
          errors: toNumber(totals?.errors),
          insufficient: toNumber(totals?.insufficient),
          avgLatencyMs: toNullableNumber(totals?.avg_latency),
          p95LatencyMs: toNullableNumber(totals?.p95_latency),
        },
        byMode,
        recent: recentRows.map((row) => ({
          id: String(row.id),
          query: String(row.query),
          mode: row.mode === 'deep' ? 'deep' : 'standard',
          collectionId: row.collection_id ? String(row.collection_id) : null,
          latencyMs: toNumber(row.latency_ms),
          chunksRetrieved: toNumber(row.chunks_retrieved),
          status: asStatus(row.status),
          createdAt: toIso(row.created_at),
        })),
      }
    },
  }
}
