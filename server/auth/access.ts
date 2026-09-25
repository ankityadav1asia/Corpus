import type { Role } from '@/lib/constants'
import type { Collection } from '@/lib/contracts'
import { can, effectiveCollectionRole, permissionMessage, type Permission } from '@/server/auth/permissions'
import { Errors } from '@/server/http/errors'
import type { Repositories } from '@/server/repositories'
import type { CollectionRecord } from '@/server/repositories/collections'

/** Who is acting, in which workspace, with which role. Resolved once per request. */
export interface WorkspaceAccess {
  userId: string
  workspaceId: string
  role: Role
  isPersonal: boolean
}

/** Non-members get 404 (not 403) so workspace ids cannot be probed. */
export async function resolveWorkspaceAccess(repos: Pick<Repositories, 'workspaces'>, userId: string, workspaceId: string): Promise<WorkspaceAccess> {
  const membership = await repos.workspaces.membership(workspaceId, userId)
  if (!membership) throw Errors.notFound('Workspace')
  return { userId, workspaceId, role: membership.role, isPersonal: membership.isPersonal }
}

export function requirePermission(role: Role | null | undefined, permission: Permission) {
  if (!can(role, permission)) throw Errors.forbidden(permissionMessage(permission))
}

export function requireWorkspacePermission(access: WorkspaceAccess, permission: Permission) {
  requirePermission(access.role, permission)
}

/**
 * Things members create and share with the workspace (reports, images, audio overviews, mind maps,
 * connected accounts, public links) are managed by their creator or by a workspace admin.
 */
export function canManageOwned(access: WorkspaceAccess, ownerId: string | null): boolean {
  return ownerId === access.userId || access.role === 'admin'
}

export function requireOwnerOrAdmin(access: WorkspaceAccess, ownerId: string | null, action: string) {
  if (!canManageOwned(access, ownerId)) throw Errors.forbidden(`Only its creator or a workspace admin can ${action}.`)
}

/** Adds the caller's effective role to a stored notebook for API responses. */
export function withMyRole(access: WorkspaceAccess, record: CollectionRecord): Collection {
  const { override, ...collection } = record
  return { ...collection, myRole: effectiveCollectionRole(access.role, override) ?? 'viewer' }
}

export interface CollectionAccess {
  collection: { id: string; name: string }
  role: Role
}

/** Loads a notebook of the active workspace and the caller's effective role on it. */
export async function collectionAccess(repos: Pick<Repositories, 'collections'>, access: WorkspaceAccess, collectionId: string): Promise<CollectionAccess> {
  const found = await repos.collections.get(access.workspaceId, collectionId, access.userId)
  if (!found) throw Errors.notFound('Notebook')
  return { collection: { id: found.id, name: found.name }, role: effectiveCollectionRole(access.role, found.override) ?? 'viewer' }
}

export async function requireCollectionPermission(
  repos: Pick<Repositories, 'collections'>,
  access: WorkspaceAccess,
  collectionId: string,
  permission: Permission,
): Promise<CollectionAccess> {
  const result = await collectionAccess(repos, access, collectionId)
  requirePermission(result.role, permission)
  return result
}
