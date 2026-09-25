import type { Role } from '@/lib/constants'
import type { SessionUser } from '@/lib/contracts'
import type { WorkspaceAccess } from '@/server/auth/access'
import type { Repositories } from '@/server/repositories'

import { fakeEmbedding } from './fake-ai'

export interface TestUser {
  user: SessionUser
  id: string
  /** Personal workspace. */
  workspaceId: string
  /** Default notebook of the personal workspace. */
  notebookId: string
}

/** A signed-up user with a personal workspace and its default notebook (what completeLogin sets up). */
export async function createUser(repos: Repositories, email: string, name: string | null = null): Promise<TestUser> {
  const { user } = await repos.users.upsertOnLogin(email, name)
  const workspaceId = await repos.workspaces.ensurePersonal(user.id)
  await repos.collections.ensureDefault(workspaceId, user.id)
  const [notebook] = await repos.collections.list(workspaceId, user.id)
  return { user, id: user.id, workspaceId, notebookId: notebook!.id }
}

/** A team workspace owned by `admin`, with extra members at the given roles, and one notebook. */
export async function createTeam(repos: Repositories, admin: TestUser, members: Array<[TestUser, Role]> = [], name = 'Team') {
  const workspace = await repos.workspaces.create(name, admin.id)
  await repos.collections.ensureDefault(workspace.id, admin.id)
  for (const [member, role] of members) await repos.workspaces.addMember(workspace.id, member.id, role)
  const [notebook] = await repos.collections.list(workspace.id, admin.id)
  return { workspaceId: workspace.id, notebookId: notebook!.id }
}

export function accessFor(userId: string, workspaceId: string, role: Role, isPersonal = false): WorkspaceAccess {
  return { userId, workspaceId, role, isPersonal }
}

/** Inserts a document with pre-computed (fake) embeddings, bypassing the ingest service. */
export async function addDocument(
  repos: Repositories,
  input: { workspaceId: string; collectionId: string; createdBy: string; title: string; chunks: string[]; ready?: boolean; source?: string },
) {
  const document = await repos.documents.createProcessing({
    workspaceId: input.workspaceId,
    collectionId: input.collectionId,
    createdBy: input.createdBy,
    sourceType: 'text',
    source: input.source ?? input.title,
    title: input.title,
  })
  await repos.documents.insertChunks(
    { id: document.id, workspaceId: input.workspaceId, collectionId: input.collectionId },
    input.chunks.map((content) => ({ content, embedding: fakeEmbedding(content) })),
  )
  return input.ready === false ? document : repos.documents.markReady(document.id, input.chunks.length, input.chunks.join('').length)
}
