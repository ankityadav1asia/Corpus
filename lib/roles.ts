import { ROLES, type Role } from '@/lib/constants'

/** UI-side role checks. The server enforces the same rules (server/auth/permissions.ts); this only hides controls. */
export function atLeast(role: Role | null | undefined, required: Role): boolean {
  return role !== null && role !== undefined && ROLES.indexOf(role) >= ROLES.indexOf(required)
}

/** Mirrors server/auth/access.ts → canManageOwned: the creator or a workspace admin manages an item. */
export function canManageOwned(role: Role | null | undefined, createdByEmail: string | null, myEmail: string): boolean {
  return role === 'admin' || (createdByEmail !== null && createdByEmail === myEmail)
}

export const ROLE_LABELS: Record<Role, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' }

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Search, chat and create reports',
  editor: 'Also add sources, edit chunks and manage benchmarks',
  admin: 'Also manage members, settings and notebooks',
}
