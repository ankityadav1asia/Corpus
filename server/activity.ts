import type { WorkspaceAccess } from '@/server/auth/access'
import { log } from '@/server/logger'
import type { Repositories } from '@/server/repositories'
import type { NewNotification } from '@/server/repositories/notifications'

/**
 * Side records of what happened: in-app notifications and the workspace audit log.
 * Both are best-effort — failing to record must never fail the action itself.
 */

export async function notify(repos: Pick<Repositories, 'notifications'>, notification: NewNotification): Promise<void> {
  try {
    await repos.notifications.create(notification)
  } catch (error) {
    log.warn('Could not create notification', { kind: notification.kind, error: String(error) })
  }
}

export async function recordAudit(
  repos: Pick<Repositories, 'audit'>,
  access: Pick<WorkspaceAccess, 'workspaceId' | 'userId'>,
  action: string,
  target?: { type: string; id: string } | null,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await repos.audit.record({ workspaceId: access.workspaceId, actorId: access.userId, action, targetType: target?.type ?? null, targetId: target?.id ?? null, details })
  } catch (error) {
    log.error('Could not write audit event', error, { action })
  }
}
