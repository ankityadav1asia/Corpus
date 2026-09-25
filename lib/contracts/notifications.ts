/** In-app notifications. */
import { z } from 'zod'

import type { WorkspaceTab } from '@/lib/constants'

import { id } from './fields'

export const notificationsReadSchema = z
  .object({ ids: z.array(id).max(100).optional(), all: z.boolean().optional() })
  .refine((value) => Boolean(value.all) || (value.ids?.length ?? 0) > 0, 'Nothing to mark as read')

export type NotificationKind =
  | 'document_ready'
  | 'document_failed'
  | 'report_ready'
  | 'report_failed'
  | 'image_ready'
  | 'image_failed'
  | 'audio_ready'
  | 'audio_failed'
  | 'mindmap_ready'
  | 'mindmap_failed'
  | 'sync_done'
  | 'sync_failed'
  | 'benchmark_done'
  | 'benchmark_failed'
  | 'member_added'

/** Where a notification leads in the app. */
export interface NotificationLink {
  tab: WorkspaceTab | 'sources'
  id?: string
}

export interface NotificationItem {
  id: string
  kind: NotificationKind
  title: string
  body: string | null
  link: NotificationLink | null
  workspaceId: string | null
  workspaceName: string | null
  readAt: string | null
  createdAt: string
}
