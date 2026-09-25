'use client'

import { Database, Download, Menu, MoreHorizontal, PanelLeft, Pin, PinOff, Search, Share2, Trash2 } from 'lucide-react'

import { NotificationsMenu } from '@/components/notifications-menu'
import { Kbd } from '@/components/ui/feedback-primitives'
import { MenuItem, MenuSeparator, Popover } from '@/components/ui/popover'
import type { ConversationSummary, NotificationItem } from '@/lib/contracts'
import { plural } from '@/lib/format'

const HEADER_BUTTON = 'flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-card/60 text-muted-foreground transition-colors hover:text-foreground'

interface ChatActions {
  /** The open conversation (null before the first answer is saved). */
  conversation: ConversationSummary | null
  onPin: (pinned: boolean) => void
  onShare: () => void
  onExport: (format: 'markdown' | 'json') => void
  onDelete: () => void
}

/** The open chat's menu: pin, share, export, delete. */
function ChatActionsMenu({ conversation, onPin, onShare, onExport, onDelete }: ChatActions) {
  return (
    <Popover label="Chat actions" width={210} triggerClassName={HEADER_BUTTON} trigger={<MoreHorizontal className="size-4" />}>
      {(close) => {
        const run = (action: () => void) => () => {
          close()
          action()
        }
        return (
          <>
            {conversation && (
              <>
                <MenuItem icon={conversation.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />} onSelect={run(() => onPin(!conversation.pinned))}>
                  {conversation.pinned ? 'Unpin chat' : 'Pin chat'}
                </MenuItem>
                <MenuItem icon={<Share2 className="size-3.5" />} onSelect={run(onShare)}>
                  Share read-only link
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            <MenuItem icon={<Download className="size-3.5" />} onSelect={run(() => onExport('markdown'))}>
              Export as Markdown
            </MenuItem>
            <MenuItem icon={<Download className="size-3.5" />} onSelect={run(() => onExport('json'))}>
              Export as JSON
            </MenuItem>
            {conversation && (
              <>
                <MenuSeparator />
                <MenuItem danger icon={<Trash2 className="size-3.5" />} onSelect={run(onDelete)}>
                  Delete chat
                </MenuItem>
              </>
            )}
          </>
        )
      }}
    </Popover>
  )
}

export interface WorkspaceHeaderProps {
  title: string
  subtitle: string
  /** The desktop history panel is open (the button to reopen it shows only when it is not). */
  historyOpen: boolean
  onOpenNavigation: () => void
  modKey: string
  onOpenPalette: () => void
  /** Shown on the chat tab once it has messages. */
  chatActions: ChatActions | null
  activeWorkspaceId: string | null
  onNotification: (item: NotificationItem) => void
  passageCount: number
  onOpenSources: () => void
}

/** Top bar: navigation toggle, title, search, the chat's actions, notifications and sources. */
export function WorkspaceHeader(props: WorkspaceHeaderProps) {
  return (
    <header className="z-20 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="flex h-16 items-center justify-between gap-3 px-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" aria-label="Open navigation" title={`Navigation (${props.modKey}+B)`} onClick={props.onOpenNavigation} className={`${HEADER_BUTTON} lg:hidden`}>
            <Menu className="size-4" />
          </button>
          {!props.historyOpen && (
            <button
              type="button"
              aria-label="Show chat history"
              title={`Show chat history (${props.modKey}+B)`}
              onClick={props.onOpenNavigation}
              className={`${HEADER_BUTTON} hidden lg:flex`}
            >
              <PanelLeft className="size-4" />
            </button>
          )}
          <div className="min-w-0">
            <h1 className="truncate font-display text-base font-bold tracking-tight sm:text-lg" title={props.title}>
              {props.title}
            </h1>
            <p className="truncate text-[11px] text-muted-foreground">{props.subtitle}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={props.onOpenPalette}
            className="hidden items-center gap-2 rounded-xl border border-border/70 bg-card/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground md:flex"
          >
            <Search className="size-3.5" />
            <span>Search or jump to…</span>
            <span className="flex gap-0.5">
              <Kbd>{props.modKey}</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          {props.chatActions && <ChatActionsMenu {...props.chatActions} />}
          <NotificationsMenu activeWorkspaceId={props.activeWorkspaceId} onNavigate={props.onNotification} />
          <button
            type="button"
            onClick={props.onOpenSources}
            disabled={!props.activeWorkspaceId}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-border/70 bg-card/60 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-40"
          >
            <Database className="size-3.5" />
            <span className="hidden sm:inline">Sources · </span>
            {plural(props.passageCount, 'passage')}
          </button>
        </div>
      </div>
    </header>
  )
}
