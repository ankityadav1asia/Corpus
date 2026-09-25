import type { AuditEvent } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { toIso } from '@/server/repositories/sql'

export interface AuditInput {
  workspaceId: string
  actorId: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  details?: Record<string, unknown>
}

function asObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

/** Append-only record of who changed what in a workspace. */
export function auditRepository(db: Db) {
  return {
    async record(input: AuditInput): Promise<void> {
      await db.query(`INSERT INTO app.audit_events (workspace_id, actor_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [
        input.workspaceId,
        input.actorId,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        JSON.stringify(input.details ?? {}),
      ])
    },

    async list(workspaceId: string, limit = 100): Promise<AuditEvent[]> {
      const rows = await db.query(
        `SELECT e.id, e.action, e.target_type, e.target_id, e.details, e.created_at, u.email AS actor_email
         FROM app.audit_events e LEFT JOIN app.users u ON u.id = e.actor_id
         WHERE e.workspace_id = $1
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $2`,
        [workspaceId, limit],
      )
      return rows.map((row) => ({
        id: String(row.id),
        action: String(row.action),
        targetType: row.target_type ? String(row.target_type) : null,
        targetId: row.target_id ? String(row.target_id) : null,
        details: asObject(row.details),
        actorEmail: row.actor_email ? String(row.actor_email) : null,
        createdAt: toIso(row.created_at),
      }))
    },
  }
}
