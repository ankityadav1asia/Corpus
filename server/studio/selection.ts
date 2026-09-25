import { collectionAccess, type WorkspaceAccess } from '@/server/auth/access'
import { Errors } from '@/server/http/errors'
import type { Repositories } from '@/server/repositories'

/**
 * Checks a studio selection before anything is queued: every notebook must be readable by the caller
 * and every document must exist in the workspace and be indexed. Studio outputs only ever draw on
 * content the requester can already read.
 */
export async function checkSelection(repos: Repositories, access: WorkspaceAccess, selection: { collectionIds: string[]; documentIds: string[] }): Promise<void> {
  for (const collectionId of new Set(selection.collectionIds)) await collectionAccess(repos, access, collectionId)
  const documentIds = [...new Set(selection.documentIds)]
  if (documentIds.length === 0) return
  const found = await repos.documents.resolveReportDocuments(access.workspaceId, { collectionIds: [], documentIds }, documentIds.length)
  if (found.length !== documentIds.length) throw Errors.badRequest('Some selected documents do not exist or are not indexed yet.')
  // Documents chosen one by one must also be in notebooks the caller can read.
  for (const collectionId of new Set(found.map((document) => document.collectionId))) await collectionAccess(repos, access, collectionId)
}

/** A readable default title from the chosen notebooks ("Audio overview · Research"). */
export async function selectionTitle(repos: Repositories, access: WorkspaceAccess, prefix: string, collectionIds: string[]): Promise<string> {
  if (collectionIds.length === 0) return prefix
  const collections = await repos.collections.list(access.workspaceId, access.userId)
  const names = collections.filter((collection) => collectionIds.includes(collection.id)).map((collection) => collection.name)
  return names.length ? `${prefix} · ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`.slice(0, 200) : prefix
}
