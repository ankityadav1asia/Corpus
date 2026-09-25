import type { Role } from '@/lib/constants'
import { workspaceSettingsSchema, type WorkspaceInvite, type WorkspaceMember, type WorkspaceSettings, type WorkspaceSettingsPatch, type WorkspaceSummary } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { toIso, toNumber } from '@/server/repositories/sql'

function mapSummary(row: Record<string, unknown>): WorkspaceSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    role: row.role as Role,
    isPersonal: Boolean(row.is_personal),
    memberCount: toNumber(row.member_count, 1),
    createdAt: toIso(row.created_at),
  }
}

/** Stored settings are parsed on read, so missing or unknown keys always fall back to defaults. */
export function parseSettings(value: unknown): WorkspaceSettings {
  const parsed = workspaceSettingsSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : workspaceSettingsSchema.parse({})
}

/** Applies a partial update group by group and re-validates the result. */
export function mergeSettings(current: WorkspaceSettings, patch: WorkspaceSettingsPatch): WorkspaceSettings {
  return workspaceSettingsSchema.parse({
    retrieval: { ...current.retrieval, ...patch.retrieval },
    guardrail: { ...current.guardrail, ...patch.guardrail },
    evaluation: { ...current.evaluation, ...patch.evaluation },
  })
}

const SUMMARY_COLUMNS = `w.id, w.name, w.created_at, m.role, (w.personal_user_id IS NOT NULL) AS is_personal,
  (SELECT count(*) FROM app.workspace_members mm WHERE mm.workspace_id = w.id)::int AS member_count`

export type MembershipChange = 'ok' | 'not_found' | 'last_admin'

export function workspacesRepository(db: Db) {
  async function membership(workspaceId: string, userId: string): Promise<{ role: Role; isPersonal: boolean } | null> {
    const [row] = await db.query<{ role: Role; is_personal: boolean }>(
      `SELECT m.role, (w.personal_user_id IS NOT NULL) AS is_personal
       FROM app.workspace_members m JOIN app.workspaces w ON w.id = m.workspace_id
       WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [workspaceId, userId],
    )
    return row ? { role: row.role, isPersonal: Boolean(row.is_personal) } : null
  }

  return {
    /** Idempotently creates the user's personal workspace (and admin membership); returns its id. */
    async ensurePersonal(userId: string): Promise<string> {
      const [row] = await db.query<{ id: string }>(
        `WITH created AS (
           INSERT INTO app.workspaces (name, personal_user_id, created_by) VALUES ('Personal', $1, $1)
           ON CONFLICT (personal_user_id) DO NOTHING
           RETURNING id
         ),
         workspace AS (
           SELECT id FROM created
           UNION ALL
           SELECT id FROM app.workspaces WHERE personal_user_id = $1
         ),
         membership AS (
           INSERT INTO app.workspace_members (workspace_id, user_id, role)
           SELECT id, $1, 'admin' FROM workspace LIMIT 1
           ON CONFLICT DO NOTHING
         )
         SELECT id FROM workspace LIMIT 1`,
        [userId],
      )
      if (row) return String(row.id)
      // A concurrent first sign-in created it after this statement's snapshot was taken; it has
      // committed by now (our insert waited for it), so a new statement sees it.
      const [existing] = await db.query<{ id: string }>(`SELECT id FROM app.workspaces WHERE personal_user_id = $1`, [userId])
      if (!existing) throw new Error('Could not create the personal workspace')
      return String(existing.id)
    },

    async listForUser(userId: string): Promise<WorkspaceSummary[]> {
      const rows = await db.query(
        `SELECT ${SUMMARY_COLUMNS}
         FROM app.workspace_members m JOIN app.workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = $1
         ORDER BY (w.personal_user_id IS NOT NULL) DESC, w.created_at, w.name`,
        [userId],
      )
      return rows.map(mapSummary)
    },

    membership,

    async summary(workspaceId: string, userId: string): Promise<WorkspaceSummary | null> {
      const [row] = await db.query(
        `SELECT ${SUMMARY_COLUMNS}
         FROM app.workspace_members m JOIN app.workspaces w ON w.id = m.workspace_id
         WHERE w.id = $1 AND m.user_id = $2`,
        [workspaceId, userId],
      )
      return row ? mapSummary(row) : null
    },

    async settings(workspaceId: string): Promise<WorkspaceSettings> {
      const [row] = await db.query<{ settings: unknown }>(`SELECT settings FROM app.workspaces WHERE id = $1`, [workspaceId])
      return parseSettings(row?.settings)
    },

    async saveSettings(workspaceId: string, settings: WorkspaceSettings): Promise<void> {
      await db.query(`UPDATE app.workspaces SET settings = $2::jsonb WHERE id = $1`, [workspaceId, JSON.stringify(settings)])
    },

    async create(name: string, userId: string): Promise<WorkspaceSummary> {
      const [row] = await db.query(
        `WITH w AS (
           INSERT INTO app.workspaces (name, created_by) VALUES ($1, $2) RETURNING id, name, created_at
         ),
         m AS (
           INSERT INTO app.workspace_members (workspace_id, user_id, role) SELECT id, $2, 'admin' FROM w RETURNING role
         )
         SELECT w.id, w.name, w.created_at, 'admin' AS role, false AS is_personal, 1 AS member_count FROM w`,
        [name, userId],
      )
      if (!row) throw new Error('Workspace insert returned no row')
      return mapSummary(row)
    },

    async rename(workspaceId: string, name: string): Promise<void> {
      await db.query(`UPDATE app.workspaces SET name = $2 WHERE id = $1`, [workspaceId, name])
    },

    /** Personal workspaces cannot be deleted. Cascades to every notebook, document and conversation. */
    async delete(workspaceId: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.workspaces WHERE id = $1 AND personal_user_id IS NULL RETURNING id`, [workspaceId])
      return rows.length > 0
    },

    async members(workspaceId: string): Promise<WorkspaceMember[]> {
      const rows = await db.query(
        `SELECT u.id, u.email, u.name, m.role, m.created_at
         FROM app.workspace_members m JOIN app.users u ON u.id = m.user_id
         WHERE m.workspace_id = $1
         ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.email`,
        [workspaceId],
      )
      return rows.map((row) => ({
        userId: String(row.id),
        email: String(row.email),
        name: row.name ? String(row.name) : null,
        role: row.role as Role,
        joinedAt: toIso(row.created_at),
      }))
    },

    async invites(workspaceId: string): Promise<WorkspaceInvite[]> {
      const rows = await db.query(`SELECT email, role, created_at FROM app.workspace_invites WHERE workspace_id = $1 ORDER BY created_at`, [workspaceId])
      return rows.map((row) => ({ email: String(row.email), role: row.role as Role, createdAt: toIso(row.created_at) }))
    },

    async findUserIdByEmail(email: string): Promise<string | null> {
      const [row] = await db.query<{ id: string }>(`SELECT id FROM app.users WHERE email = $1`, [email.toLowerCase()])
      return row ? String(row.id) : null
    },

    /** Adds a member, or changes the role of an existing one. */
    async addMember(workspaceId: string, userId: string, role: Role): Promise<void> {
      await db.query(
        `INSERT INTO app.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [workspaceId, userId, role],
      )
    },

    /**
     * Changes a role but never leaves the workspace without an admin. The workspace row is locked
     * first, so two admins demoting each other at the same time cannot both succeed.
     */
    async setRole(workspaceId: string, userId: string, role: Role): Promise<MembershipChange> {
      const [, updated] = await db.transaction([
        { text: `SELECT id FROM app.workspaces WHERE id = $1 FOR UPDATE`, params: [workspaceId] },
        {
          text: `UPDATE app.workspace_members m SET role = $3
                 WHERE m.workspace_id = $1 AND m.user_id = $2
                   AND ($3 = 'admin' OR m.role <> 'admin'
                        OR (SELECT count(*) FROM app.workspace_members a WHERE a.workspace_id = $1 AND a.role = 'admin') > 1)
                 RETURNING m.user_id`,
          params: [workspaceId, userId, role],
        },
      ])
      if (updated && updated.length > 0) return 'ok'
      return (await membership(workspaceId, userId)) ? 'last_admin' : 'not_found'
    },

    async removeMember(workspaceId: string, userId: string): Promise<MembershipChange> {
      const [, removed] = await db.transaction([
        { text: `SELECT id FROM app.workspaces WHERE id = $1 FOR UPDATE`, params: [workspaceId] },
        {
          text: `DELETE FROM app.workspace_members m
                 WHERE m.workspace_id = $1 AND m.user_id = $2
                   AND (m.role <> 'admin'
                        OR (SELECT count(*) FROM app.workspace_members a WHERE a.workspace_id = $1 AND a.role = 'admin') > 1)
                 RETURNING m.user_id`,
          params: [workspaceId, userId],
        },
      ])
      if (removed && removed.length > 0) {
        // Their per-notebook overrides in this workspace no longer mean anything.
        await db.query(
          `DELETE FROM app.collection_roles cr USING app.collections c
           WHERE cr.collection_id = c.id AND c.workspace_id = $1 AND cr.user_id = $2`,
          [workspaceId, userId],
        )
        // Their connected accounts go with them (and so do the sources syncing through them), so
        // the workspace never keeps using a former member's Drive, Notion or GitHub access.
        await db.query(`DELETE FROM app.connections WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId])
        // Public links they created stop working.
        await db.query(`UPDATE app.share_links SET revoked_at = now() WHERE workspace_id = $1 AND created_by = $2 AND revoked_at IS NULL`, [workspaceId, userId])
        return 'ok'
      }
      return (await membership(workspaceId, userId)) ? 'last_admin' : 'not_found'
    },

    async upsertInvite(workspaceId: string, email: string, role: Role, invitedBy: string): Promise<void> {
      await db.query(
        `INSERT INTO app.workspace_invites (workspace_id, email, role, invited_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, email) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, created_at = now()`,
        [workspaceId, email.toLowerCase(), role, invitedBy],
      )
    },

    async deleteInvite(workspaceId: string, email: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.workspace_invites WHERE workspace_id = $1 AND email = $2 RETURNING email`, [workspaceId, email.toLowerCase()])
      return rows.length > 0
    },

    /** Turns pending invitations for this email into memberships (called on every sign-in). */
    async acceptInvites(userId: string, email: string): Promise<number> {
      const rows = await db.query(
        `WITH accepted AS (
           DELETE FROM app.workspace_invites WHERE email = $2 RETURNING workspace_id, role
         )
         INSERT INTO app.workspace_members (workspace_id, user_id, role)
         SELECT workspace_id, $1, role FROM accepted
         ON CONFLICT (workspace_id, user_id) DO NOTHING
         RETURNING workspace_id`,
        [userId, email.toLowerCase()],
      )
      return rows.length
    },
  }
}
