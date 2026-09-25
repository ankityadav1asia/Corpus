'use client'

import { Loader2, MessageSquare } from 'lucide-react'
import { useMemo } from 'react'

import { useConversationSearch } from '@/hooks/use-api'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import type { ConversationSummary } from '@/lib/contracts'
import { timeAgo } from '@/lib/format'
import { groupConversations } from '@/lib/history'

import { ConversationItem } from './conversation-item'
import { HistoryHeading } from './parts'

/** The sidebar list shows this many recent chats (the API limit); search finds older ones. */
const RECENT_LIMIT = 100

export interface ConversationActions {
  activeId: string | null
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => Promise<boolean>
  onPin: (id: string, pinned: boolean) => void
}

function itemProps(conversation: ConversationSummary, actions: ConversationActions) {
  return {
    conversation,
    active: conversation.id === actions.activeId,
    onOpen: () => actions.onOpen(conversation.id),
    onDelete: () => actions.onDelete(conversation.id),
    onRename: (title: string) => actions.onRename(conversation.id, title),
    onPin: (pinned: boolean) => actions.onPin(conversation.id, pinned),
  }
}

/** Matches across every chat (titles and messages), not only the recent ones in the list. */
function SearchResults({ search, found, pending, actions }: { search: string; found: ConversationSummary[]; pending: boolean; actions: ConversationActions }) {
  return (
    <>
      <HistoryHeading>
        <span className="flex items-center gap-1.5">Search results {pending && <Loader2 className="size-3 animate-spin" />}</span>
      </HistoryHeading>
      {found.length === 0 && !pending ? (
        <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">No chats mention “{search}”.</p>
      ) : (
        <ul className="space-y-px">
          {found.map((conversation) => (
            <ConversationItem key={conversation.id} {...itemProps(conversation, actions)} meta={`${conversation.pinned ? 'Pinned · ' : ''}${timeAgo(conversation.updatedAt)}`} />
          ))}
        </ul>
      )}
    </>
  )
}

/** Recent chats grouped by pinned, day, week and month — or search results while searching. */
export function HistoryList({ search, conversations, loading, actions }: { search: string; conversations: ConversationSummary[]; loading: boolean; actions: ConversationActions }) {
  const groups = useMemo(() => groupConversations(conversations), [conversations])
  const query = useDebouncedValue(search, 250)
  const results = useConversationSearch(query)

  if (search) {
    const pending = query !== search || (results.isLoading && !results.data)
    return <SearchResults search={search} found={results.data?.conversations ?? []} pending={pending} actions={actions} />
  }
  if (loading && conversations.length === 0) {
    return (
      <div className="space-y-2 px-2.5 pt-4" aria-label="Loading chats">
        {[70, 55, 80, 60].map((width) => (
          <div key={width} className="skeleton h-4" style={{ width: `${width}%` }} />
        ))}
      </div>
    )
  }
  if (conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto size-6 text-muted-foreground/60" />
        <p className="mt-2 text-xs font-medium">No chats yet</p>
        <p className="mt-1 text-[11px] text-muted-foreground">Your conversations appear here, grouped by day.</p>
      </div>
    )
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <HistoryHeading>{group.label}</HistoryHeading>
          <ul className="space-y-px">
            {group.items.map((conversation) => (
              <ConversationItem key={conversation.id} {...itemProps(conversation, actions)} />
            ))}
          </ul>
        </section>
      ))}
      {conversations.length >= RECENT_LIMIT && (
        <p className="px-2.5 pb-2 pt-4 text-center text-[11px] text-muted-foreground">Showing your {RECENT_LIMIT} most recent chats — search to find older ones.</p>
      )}
    </>
  )
}
