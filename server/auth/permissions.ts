import { ROLES, type Role } from '@/lib/constants'

/**
 * Role-based access control. Pure functions only, so the policy is easy to test and reason about.
 *
 * - Every workspace member has a workspace role (viewer < editor < admin).
 * - A notebook (collection) can override a member's role up or down.
 * - Workspace admins are always admins of every notebook (overrides cannot lock them out).
 */
export const PERMISSIONS = {
  'workspace.view': 'viewer',
  'workspace.manage': 'admin',
  'members.manage': 'admin',
  'analytics.workspace': 'admin',
  'evaluation.manage': 'editor',
  'collection.create': 'editor',
  'collection.view': 'viewer',
  'collection.search': 'viewer',
  'collection.ingest': 'editor',
  'collection.editChunks': 'editor',
  'collection.manage': 'admin',
  'reports.create': 'viewer',
  'images.create': 'viewer',
  'audio.create': 'viewer',
  'mindmaps.create': 'viewer',
  // Connecting your own Drive / Notion / GitHub account and syncing into notebooks you can edit.
  'connectors.use': 'editor',
  // Public read-only links to a conversation or report (their content leaves the workspace).
  'shares.create': 'editor',
  // Slack / Microsoft Teams bots that answer from this workspace.
  'integrations.manage': 'admin',
} as const satisfies Record<string, Role>

export type Permission = keyof typeof PERMISSIONS

export function roleRank(role: Role): number {
  return ROLES.indexOf(role)
}

export function hasRole(actual: Role | null | undefined, required: Role): boolean {
  return actual !== null && actual !== undefined && roleRank(actual) >= roleRank(required)
}

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return hasRole(role, PERMISSIONS[permission])
}

/** Role a member has on one notebook: admin wins, then an explicit override, then the workspace role. */
export function effectiveCollectionRole(workspaceRole: Role | null | undefined, override: Role | null | undefined): Role | null {
  if (!workspaceRole) return null
  if (workspaceRole === 'admin') return 'admin'
  return override ?? workspaceRole
}

const MESSAGES: Record<Permission, string> = {
  'workspace.view': 'You are not a member of this workspace.',
  'workspace.manage': 'Only workspace admins can change workspace settings.',
  'members.manage': 'Only workspace admins can manage members.',
  'analytics.workspace': 'Only workspace admins can see workspace-wide analytics.',
  'evaluation.manage': 'You need Editor access to manage evaluation benchmarks.',
  'collection.create': 'You need Editor access to create notebooks.',
  'collection.view': 'You do not have access to this notebook.',
  'collection.search': 'You do not have access to this notebook.',
  'collection.ingest': 'You need Editor access to this notebook to add sources.',
  'collection.editChunks': 'You need Editor access to this notebook to change its content.',
  'collection.manage': 'You need Admin access to this notebook.',
  'reports.create': 'You do not have access to these sources.',
  'images.create': 'You do not have access to these sources.',
  'audio.create': 'You do not have access to these sources.',
  'mindmaps.create': 'You do not have access to these sources.',
  'connectors.use': 'You need Editor access to connect apps and import from them.',
  'shares.create': 'You need Editor access to share links outside the workspace.',
  'integrations.manage': 'Only workspace admins can connect Slack or Microsoft Teams.',
}

export function permissionMessage(permission: Permission): string {
  return MESSAGES[permission]
}
