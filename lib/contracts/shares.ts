/** Read-only public links to conversations and reports. */
import { z } from 'zod'

import { id } from './fields'

export const SHARE_KINDS = ['conversation', 'report'] as const
export type ShareKind = (typeof SHARE_KINDS)[number]

export const shareCreateSchema = z.object({ kind: z.enum(SHARE_KINDS), id })
export const shareQuerySchema = z.object({ kind: z.enum(SHARE_KINDS), id })

/** A read-only public link (the content is a snapshot taken when the link was made). */
export interface ShareLink {
  id: string
  kind: ShareKind
  targetId: string
  title: string
  /**
   * null when the stored token can no longer be decrypted (AUTH_SECRET replaced without
   * AUTH_SECRET_PREVIOUS): the link still works for people who have it; turn it off and share again.
   */
  url: string | null
  viewCount: number
  lastViewedAt: string | null
  createdAt: string
  createdByEmail: string | null
}

/** Citations as shown on a public page: no internal ids. */
export interface SharedCitation {
  index: number
  title: string
  source: string
  excerpt: string
}

export type SharedSnapshot =
  { kind: 'conversation'; messages: Array<{ role: 'user' | 'assistant'; content: string; citations: SharedCitation[] }> } | { kind: 'report'; template: string; content: string }

export interface SharedView {
  title: string
  kind: ShareKind
  workspaceName: string
  createdAt: string
  snapshot: SharedSnapshot
}
