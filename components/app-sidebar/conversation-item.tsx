'use client'

import { GitBranch, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { MenuItem, MenuSeparator, Popover } from '@/components/ui/popover'
import { LIMITS } from '@/lib/constants'
import type { ConversationSummary } from '@/lib/contracts'
import { cn } from '@/lib/utils'

import { InlineNameForm } from './parts'

export function ConversationItem({
  conversation,
  active,
  meta,
  onOpen,
  onDelete,
  onRename,
  onPin,
}: {
  conversation: ConversationSummary
  active: boolean
  /** Second line (search results show when the chat was last active). */
  meta?: string
  onOpen: () => void
  onDelete: () => void
  onRename: (title: string) => Promise<boolean>
  onPin: (pinned: boolean) => void
}) {
  const [renaming, setRenaming] = useState(false)
  if (renaming) {
    return (
      <li className="px-1 py-1">
        <InlineNameForm initial={conversation.title} label="Conversation title" maxLength={LIMITS.conversationTitleChars} onSave={onRename} onCancel={() => setRenaming(false)} />
      </li>
    )
  }
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onOpen}
        title={conversation.title}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] leading-5 transition-colors group-focus-within:pr-9 group-hover:pr-9',
          active ? 'bg-secondary pr-9 font-medium text-foreground' : 'text-foreground/80 hover:bg-secondary/60 hover:text-foreground',
        )}
      >
        {conversation.parentId && <GitBranch aria-label="Branched chat" className="size-3.5 shrink-0 text-primary" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{conversation.title}</span>
          {meta && <span className="block truncate text-[11px] font-normal text-muted-foreground">{meta}</span>}
        </span>
      </button>
      <div className={cn('absolute right-1 top-1/2 -translate-y-1/2 transition-opacity focus-within:opacity-100 group-hover:opacity-100', active ? 'opacity-100' : 'opacity-0')}>
        <Popover
          label={`Actions for ${conversation.title}`}
          width={180}
          triggerClassName="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground"
          trigger={<MoreHorizontal className="size-4" />}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Pencil className="size-3.5" />}
                onSelect={() => {
                  close()
                  setRenaming(true)
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                icon={conversation.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                onSelect={() => {
                  close()
                  onPin(!conversation.pinned)
                }}
              >
                {conversation.pinned ? 'Unpin' : 'Pin to top'}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<Trash2 className="size-3.5" />}
                onSelect={() => {
                  close()
                  onDelete()
                }}
              >
                Delete
              </MenuItem>
            </>
          )}
        </Popover>
      </div>
    </li>
  )
}
