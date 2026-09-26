import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import { ROLES, type Role } from '@/lib/constants'
import type { SessionUser } from '@/lib/contracts'
import {
  collectionAccess,
  requireCollectionPermission,
  requirePermission,
  requireWorkspacePermission,
  resolveWorkspaceAccess,
  withMyRole,
  type WorkspaceAccess,
} from '@/server/auth/access'
import { PERMISSIONS, can, effectiveCollectionRole, guestCan, hasRole, permissionMessage, type Permission } from '@/server/auth/permissions'
import { SESSION_COOKIE, createSessionToken } from '@/server/auth/session'
import { resetEnvCache } from '@/server/env'
import { AppError } from '@/server/http/errors'
import { WORKSPACE_HEADER, json, workspaceRoute } from '@/server/http/route'
import type { Repositories } from '@/server/repositories'
import { setServicesForTests, type Services } from '@/server/services'

/**
 * Authorization is layered: workspaceRoute resolves membership (404 for outsiders), then handlers
 * ask for a permission, optionally on one notebook where a per-notebook override may apply.
 */

const SECRET = 'z'.repeat(48)
const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const NOTEBOOK = '22222222-2222-4222-8222-222222222222'
const member: SessionUser = { id: '33333333-3333-4333-8333-333333333333', email: 'member@example.com', name: null }
const outsider: SessionUser = { id: '44444444-4444-4444-8444-444444444444', email: 'outsider@example.com', name: null }

/** In-memory stand-ins for the two repository calls authorization needs. */
function fakeRepos(roles: Record<string, { role: Role; isPersonal?: boolean }>, overrides: Record<string, Role> = {}) {
  return {
    workspaces: {
      async membership(workspaceId: string, userId: string) {
        const entry = workspaceId === WORKSPACE ? roles[userId] : undefined
        return entry ? { role: entry.role, isPersonal: entry.isPersonal ?? false } : null
      },
    },
    collections: {
      async get(workspaceId: string, id: string, userId: string) {
        return workspaceId === WORKSPACE && id === NOTEBOOK ? { id, name: 'Notebook', override: overrides[userId] ?? null } : null
      },
    },
    sessions: {
      async isActive() {
        return true
      },
    },
  } as unknown as Repositories
}

const access = (role: Role, userId = member.id): WorkspaceAccess => ({ userId, workspaceId: WORKSPACE, role, isPersonal: false })
const isStatus = (status: number) => (error: unknown) => error instanceof AppError && error.status === status

describe('role hierarchy and permission matrix', () => {
  it('ranks viewer < editor < admin', () => {
    assert.deepEqual([...ROLES], ['viewer', 'editor', 'admin'])
    assert.equal(hasRole('admin', 'editor'), true)
    assert.equal(hasRole('editor', 'editor'), true)
    assert.equal(hasRole('viewer', 'editor'), false)
    assert.equal(hasRole(null, 'viewer'), false)
    assert.equal(hasRole(undefined, 'viewer'), false)
  })

  it('grants every permission exactly to the roles at or above its minimum', () => {
    const expected: Record<Role, Permission[]> = {
      viewer: ['workspace.view', 'collection.view', 'collection.search', 'reports.create', 'images.create', 'audio.create', 'mindmaps.create'],
      editor: [
        'workspace.view',
        'evaluation.manage',
        'collection.create',
        'collection.view',
        'collection.search',
        'collection.ingest',
        'collection.editChunks',
        'reports.create',
        'images.create',
        'audio.create',
        'mindmaps.create',
        'connectors.use',
        'shares.create',
      ],
      admin: Object.keys(PERMISSIONS) as Permission[],
    }
    for (const role of ROLES) {
      const granted = (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => can(role, permission))
      assert.deepEqual(granted.sort(), [...expected[role]].sort(), role)
    }
    assert.ok((Object.keys(PERMISSIONS) as Permission[]).every((permission) => !can(null, permission)))
    assert.ok((Object.keys(PERMISSIONS) as Permission[]).every((permission) => permissionMessage(permission).length > 10))
  })

  it('notebook overrides move members up or down, but never below or above an admin', () => {
    assert.equal(effectiveCollectionRole('viewer', 'editor'), 'editor')
    assert.equal(effectiveCollectionRole('editor', 'viewer'), 'viewer')
    assert.equal(effectiveCollectionRole('editor', null), 'editor')
    assert.equal(effectiveCollectionRole('admin', 'viewer'), 'admin', 'workspace admins cannot be locked out')
    assert.equal(effectiveCollectionRole(null, 'admin'), null, 'an override alone grants nothing')
  })
})

describe('access resolution', () => {
  const repos = fakeRepos({ [member.id]: { role: 'editor' } }, { [member.id]: 'viewer' })

  it('resolves members and hides the workspace from everyone else (404)', async () => {
    assert.deepEqual(await resolveWorkspaceAccess(repos, member.id, WORKSPACE), { userId: member.id, workspaceId: WORKSPACE, role: 'editor', isPersonal: false })
    await assert.rejects(resolveWorkspaceAccess(repos, outsider.id, WORKSPACE), isStatus(404))
  })

  it('holds demo visitors to the read-only guest policy, whatever their role allows', async () => {
    const viewers = fakeRepos({ [member.id]: { role: 'viewer' } })
    const guest = await resolveWorkspaceAccess(viewers, member.id, WORKSPACE, { guest: true })
    assert.equal(guest.isGuest, true)
    const allowed = (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => guestCan(permission))
    assert.deepEqual(allowed, ['workspace.view', 'collection.view', 'collection.search'])
    for (const permission of ['reports.create', 'images.create', 'audio.create', 'mindmaps.create'] as const) {
      assert.doesNotThrow(() => requireWorkspacePermission({ ...guest, isGuest: undefined }, permission), 'viewers may create studio items')
      assert.throws(
        () => requireWorkspacePermission(guest, permission),
        (error: unknown) => error instanceof AppError && error.status === 403 && /read-only demo/.test(error.message),
      )
    }
    assert.doesNotThrow(() => requireWorkspacePermission(guest, 'workspace.view'))
    await assert.rejects(requireCollectionPermission(viewers, guest, NOTEBOOK, 'collection.ingest'), isStatus(403))
  })

  it('checks permissions with a 403 that says what is missing', () => {
    assert.doesNotThrow(() => requirePermission('editor', 'collection.ingest'))
    assert.throws(
      () => requirePermission('viewer', 'collection.ingest'),
      (error: unknown) => error instanceof AppError && error.status === 403 && /Editor access/.test(error.message),
    )
  })

  it('applies the notebook override when checking notebook permissions', async () => {
    const viaOverride = await collectionAccess(repos, access('editor'), NOTEBOOK)
    assert.equal(viaOverride.role, 'viewer')
    await assert.rejects(requireCollectionPermission(repos, access('editor'), NOTEBOOK, 'collection.ingest'), isStatus(403))
    await requireCollectionPermission(repos, access('editor'), NOTEBOOK, 'collection.search')
    await assert.rejects(requireCollectionPermission(repos, access('admin'), '55555555-5555-4555-8555-555555555555', 'collection.view'), isStatus(404))
    await requireCollectionPermission(repos, access('admin'), NOTEBOOK, 'collection.manage')
  })

  it('reports the caller’s effective role on each notebook', () => {
    const record = { id: NOTEBOOK, name: 'N', documentCount: 1, chunkCount: 2, createdAt: 'now', override: 'editor' as Role }
    assert.deepEqual(withMyRole(access('viewer'), record), { id: NOTEBOOK, name: 'N', documentCount: 1, chunkCount: 2, createdAt: 'now', myRole: 'editor' })
    assert.equal(withMyRole(access('admin'), { ...record, override: 'viewer' }).myRole, 'admin')
  })
})

describe('workspaceRoute middleware', () => {
  let received: WorkspaceAccess | null = null
  const handler = workspaceRoute(async ({ access: resolved }) => {
    received = resolved
    return json({ ok: true })
  })

  before(() => {
    process.env.AUTH_SECRET = SECRET
    process.env.POSTGRES_URL = 'postgres://unused'
    resetEnvCache()
    setServicesForTests({ repos: fakeRepos({ [member.id]: { role: 'viewer', isPersonal: true } }) } as unknown as Services)
  })

  after(() => setServicesForTests(null))

  async function request(user: SessionUser | null, workspace?: string) {
    const headers = new Headers()
    if (user) headers.set('cookie', `${SESSION_COOKIE}=${await createSessionToken({ id: 'session-1', user }, SECRET)}`)
    if (workspace !== undefined) headers.set(WORKSPACE_HEADER, workspace)
    received = null
    return handler(new NextRequest('http://localhost/api/anything', { headers }), { params: Promise.resolve({}) })
  }

  it('authenticates before looking at the workspace', async () => {
    assert.equal((await request(null, WORKSPACE)).status, 401)
  })

  it('rejects a missing or malformed workspace id with 400', async () => {
    assert.equal((await request(member)).status, 400)
    assert.equal((await request(member, 'workspace-1')).status, 400)
    assert.equal((await request(member, `${WORKSPACE}' OR 1=1`)).status, 400)
    assert.equal(received, null)
  })

  it('answers 404 for workspaces the caller is not a member of', async () => {
    const res = await request(outsider, WORKSPACE)
    assert.equal(res.status, 404)
    assert.equal(received, null, 'the handler never runs')
  })

  it('hands the resolved role to the handler', async () => {
    assert.equal((await request(member, WORKSPACE)).status, 200)
    assert.deepEqual(received, { userId: member.id, workspaceId: WORKSPACE, role: 'viewer', isPersonal: true })
  })
})
