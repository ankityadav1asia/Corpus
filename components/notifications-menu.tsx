'use client'

import { AlertTriangle, Bell, CheckCheck, FileBarChart, FileCheck2, FlaskConical, Headphones, Image as ImageIcon, Network, RefreshCw, UserPlus } from 'lucide-react'

import { EmptyState } from '@/components/ui/feedback-primitives'
import { Popover } from '@/components/ui/popover'
import { useNotifications } from '@/hooks/use-api'
import { apiJson } from '@/lib/api-client'
import type { NotificationItem, NotificationKind } from '@/lib/contracts'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const KIND_ICON: Record<NotificationKind, { icon: typeof Bell; tone: string }> = {
  document_ready: { icon: FileCheck2, tone: 'text-success bg-success/10' },
  document_failed: { icon: AlertTriangle, tone: 'text-destructive bg-destructive/10' },
  report_ready: { icon: FileBarChart, tone: 'text-primary bg-primary/10' },
  report_failed: { icon: AlertTriangle, tone: 'text-destructive bg-destructive/10' },
  image_ready: { icon: ImageIcon, tone: 'text-primary bg-primary/10' },
  image_failed: { icon: AlertTriangle, tone: 'text-destructive bg-destructive/10' },
  audio_ready: { icon: Headphones, tone: 'text-primary bg-primary/10' },
  audio_failed: { icon: AlertTriangle, tone: 'text-destructive bg-destructive/10' },
  mindmap_ready: { icon: Network, tone: 'text-primary bg-primary/10' },
  mindmap_failed: { icon: AlertTriangle, tone: 'text-destructive bg-destructive/10' },
  sync_done: { icon: RefreshCw, tone: 'text-success bg-success/10' },
  sync_failed: { icon: AlertTriangle, tone: 'text-destructive bg-destructive/10' },
  benchmark_done: { icon: FlaskConical, tone: 'text-success bg-success/10' },
  benchmark_failed: { icon: AlertTriangle, tone: 'text-destructive bg-destructive/10' },
  member_added: { icon: UserPlus, tone: 'text-primary bg-primary/10' },
}

interface NotificationsMenuProps {
  activeWorkspaceId: string | null
  onNavigate: (item: NotificationItem) => void
}

/** Bell with unread count; lists background work that finished and workspace invitations. */
export function NotificationsMenu({ activeWorkspaceId, onNavigate }: NotificationsMenuProps) {
  const notifications = useNotifications()
  const items = notifications.data?.items ?? []
  const unread = notifications.data?.unread ?? 0

  async function markRead(body: { ids?: string[]; all?: boolean }) {
    await apiJson('/api/notifications/read', { method: 'POST', json: body, workspaceId: null }).catch(() => undefined)
    await notifications.mutate()
  }

  return (
    <Popover
      label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
      width={360}
      triggerClassName="relative flex size-9 items-center justify-center rounded-xl border border-border/70 bg-card/60 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
      trigger={
        <>
          <Bell className="size-4" />
          {unread > 0 && (
            <span
              key={unread}
              className="absolute -right-1 -top-1 flex h-4 min-w-4 animate-pop items-center justify-center rounded-full bg-brand-gradient px-1 text-[9px] font-bold text-white shadow"
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </>
      }
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between px-2.5 py-2">
            <p className="text-xs font-semibold">Notifications</p>
            {unread > 0 && (
              <button type="button" onClick={() => void markRead({ all: true })} className="flex items-center gap-1 text-[11px] text-primary hover:underline">
                <CheckCheck className="size-3.5" /> Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <EmptyState icon={Bell} title="You're all caught up" description="Finished uploads, reports, images and benchmarks show up here." className="py-8" />
            ) : (
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const { icon: Icon, tone } = KIND_ICON[item.kind] ?? KIND_ICON.member_added
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          close()
                          if (!item.readAt) void markRead({ ids: [item.id] })
                          onNavigate(item)
                        }}
                        className={cn('flex w-full gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-secondary', !item.readAt && 'bg-primary/5')}
                      >
                        <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg', tone)}>
                          <Icon className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start gap-2">
                            <span className="min-w-0 flex-1 text-xs font-medium leading-snug">{item.title}</span>
                            {!item.readAt && <span aria-label="unread" className="mt-1 size-2 shrink-0 rounded-full bg-primary" />}
                          </span>
                          {item.body && <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">{item.body}</span>}
                          <span className="mt-1 block text-[10px] text-muted-foreground">
                            {timeAgo(item.createdAt)}
                            {item.workspaceName && item.workspaceId !== activeWorkspaceId ? ` · ${item.workspaceName}` : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Popover>
  )
}
