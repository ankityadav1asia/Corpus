import { createHash, randomBytes } from 'node:crypto'

import type { Citation, ShareKind, ShareLink, SharedCitation, SharedSnapshot, SharedView } from '@/lib/contracts'
import { safeExternalUrl } from '@/lib/api-client'
import { requireOwnerOrAdmin, requireWorkspacePermission, type WorkspaceAccess } from '@/server/auth/access'
import { Errors } from '@/server/http/errors'
import type { Repositories } from '@/server/repositories'
import type { ShareRecord } from '@/server/repositories/shares'
import { SecretUnreadableError, openSecret, sealSecret } from '@/server/security/secrets'
import type { SecretKeys } from '@/server/security/keys'

/**
 * Read-only public links. A link holds a snapshot of the conversation or report taken when it was
 * made (later messages never leak), stops working when revoked or when the original is deleted,
 * and carries a random 192-bit token that is stored hashed (lookup) and encrypted (to show again).
 */

type ShareRepos = Pick<Repositories, 'shares' | 'conversations' | 'reports'>

export const sharePath = (token: string) => `/s/${token}`

export const hashShareToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Tokens are URL-safe base64 of 24 random bytes. */
export function isShareToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(value)
}

function publicCitation(citation: Citation): SharedCitation {
  return {
    index: citation.index,
    title: citation.title,
    // Web sources keep their link; file names and internal references are shown as plain text.
    source: safeExternalUrl(citation.source) ?? citation.source.split(/[\\/]/).pop() ?? '',
    excerpt: citation.excerpt,
  }
}

async function snapshotOf(repos: ShareRepos, access: WorkspaceAccess, kind: ShareKind, id: string): Promise<{ title: string; snapshot: SharedSnapshot }> {
  if (kind === 'conversation') {
    // Conversations are private: only their author can share them.
    const conversation = await repos.conversations.get(access.workspaceId, access.userId, id)
    if (!conversation) throw Errors.notFound('Conversation')
    const messages = await repos.conversations.messages(conversation.id)
    if (messages.length === 0) throw Errors.badRequest('This conversation has no messages to share yet.')
    return {
      title: conversation.title,
      snapshot: {
        kind: 'conversation',
        messages: messages.map((message) => ({ role: message.role, content: message.content, citations: message.citations.map(publicCitation) })),
      },
    }
  }
  const report = await repos.reports.get(access.workspaceId, id)
  if (!report) throw Errors.notFound('Report')
  if (report.status !== 'completed' || !report.content) throw Errors.badRequest('Only finished reports can be shared.')
  return { title: report.title, snapshot: { kind: 'report', template: report.template, content: report.content } }
}

async function toLink(record: ShareRecord, origin: string, secret: SecretKeys): Promise<ShareLink> {
  const token = await openSecret(record.tokenSealed, secret).catch((error: unknown) => {
    // Still listed, so it can be turned off; only its address can no longer be shown.
    if (error instanceof SecretUnreadableError) return null
    throw error
  })
  return {
    id: record.id,
    kind: record.kind,
    targetId: record.targetId,
    title: record.title,
    url: token === null ? null : `${origin}${sharePath(token)}`,
    viewCount: record.viewCount,
    lastViewedAt: record.lastViewedAt,
    createdAt: record.createdAt,
    createdByEmail: record.createdByEmail,
  }
}

/** Checks the caller may see the target (and share it, when `forSharing`). */
async function assertTarget(repos: ShareRepos, access: WorkspaceAccess, kind: ShareKind, id: string) {
  if (kind === 'conversation') {
    if (!(await repos.conversations.get(access.workspaceId, access.userId, id))) throw Errors.notFound('Conversation')
  } else if (!(await repos.reports.get(access.workspaceId, id))) {
    throw Errors.notFound('Report')
  }
}

export async function createShare(repos: ShareRepos, access: WorkspaceAccess, input: { kind: ShareKind; id: string }, origin: string, secret: SecretKeys): Promise<ShareLink> {
  requireWorkspacePermission(access, 'shares.create')
  const { title, snapshot } = await snapshotOf(repos, access, input.kind, input.id)
  const token = randomBytes(24).toString('base64url')
  const record = await repos.shares.create({
    workspaceId: access.workspaceId,
    createdBy: access.userId,
    kind: input.kind,
    targetId: input.id,
    title: title.slice(0, 200) || 'Shared',
    tokenHash: hashShareToken(token),
    tokenSealed: await sealSecret(token, secret),
    snapshot,
  })
  return toLink(record, origin, secret)
}

export async function listShares(repos: ShareRepos, access: WorkspaceAccess, input: { kind: ShareKind; id: string }, origin: string, secret: SecretKeys): Promise<ShareLink[]> {
  await assertTarget(repos, access, input.kind, input.id)
  const records = await repos.shares.listFor(access.workspaceId, input.kind, input.id)
  return Promise.all(records.map((record) => toLink(record, origin, secret)))
}

/** Admins: every active public link of the workspace, to review and revoke. */
export async function listWorkspaceShares(repos: ShareRepos, access: WorkspaceAccess, origin: string, secret: SecretKeys): Promise<ShareLink[]> {
  requireWorkspacePermission(access, 'workspace.manage')
  const records = await repos.shares.listActive(access.workspaceId)
  return Promise.all(records.map((record) => toLink(record, origin, secret)))
}

/** The creator or a workspace admin can turn a link off. */
export async function revokeShare(repos: ShareRepos, access: WorkspaceAccess, id: string): Promise<void> {
  const record = await repos.shares.get(access.workspaceId, id)
  if (!record) throw Errors.notFound('Share link')
  requireOwnerOrAdmin(access, record.createdBy, 'turn this link off')
  await repos.shares.revoke(access.workspaceId, id)
}

export async function openShare(repos: Pick<Repositories, 'shares'>, token: string): Promise<SharedView | null> {
  if (!isShareToken(token)) return null
  return repos.shares.openByTokenHash(hashShareToken(token))
}
