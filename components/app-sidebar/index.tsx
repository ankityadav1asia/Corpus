'use client'

import { Database, MessageSquarePlus, PanelLeft, PanelLeftClose, Search, Settings, Sparkles, X } from 'lucide-react'
import { Fragment, useState } from 'react'

import { AccountMenu } from '@/components/account-menu'
import { TABS, type TabInfo, type WorkspaceTab } from '@/components/workspace/navigation'
import { LIMITS } from '@/lib/constants'
import type { Collection, ConversationSummary, SessionUser } from '@/lib/contracts'
import { cn } from '@/lib/utils'

import { HistoryList } from './history-list'
import { NotebookPicker } from './notebook-picker'
import { InlineNameForm, RailButton, RailDivider, RailIconButton } from './parts'
import { WorkspaceMenu } from './workspace-menu'

interface AppSidebarProps {
  /** Desktop: the history panel is shown. Mobile: the whole navigation drawer is open. */
  open: boolean
  onOpenChange: (open: boolean) => void
  user: SessionUser
  tab: WorkspaceTab
  onTabChange: (tab: WorkspaceTab) => void
  collections: Collection[]
  selected: string
  onSelect: (id: string) => void
  onCreateCollection: (name: string) => Promise<boolean>
  onRenameCollection: (id: string, name: string) => Promise<boolean>
  onDeleteCollection: (id: string) => void
  onManageCollectionAccess: (id: string) => void
  onSelectWorkspace: (id: string) => void
  onCreateWorkspace: (name: string) => Promise<boolean>
  onOpenWorkspaceSettings: () => void
  onOpenSources: () => void
  conversations: ConversationSummary[]
  conversationsLoading: boolean
  activeConversationId: string | null
  onSelectConversation: (id: string) => void
  onNewChat: () => void
  onDeleteConversation: (id: string) => void
  onRenameConversation: (id: string, title: string) => Promise<boolean>
  onPinConversation: (id: string, pinned: boolean) => void
  onOpenPalette: () => void
  onOpenShortcuts: () => void
  onLogout: (options?: { everywhere?: boolean }) => void
}

const RAIL_GROUPS: ReadonlyArray<TabInfo['group']> = ['chat', 'studio', 'tools']

/** Every view, always one click away (collapsed history panel: also "show history" and "new chat"). */
function NavigationRail(props: AppSidebarProps) {
  return (
    <nav aria-label="Views" className="flex h-full w-[76px] shrink-0 flex-col items-center border-r border-border/60 bg-card/95 px-1.5 py-3 backdrop-blur-2xl">
      <div className="mb-2 flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient shadow-md" title="Corpus">
        <Sparkles className="size-4 text-white" />
      </div>
      {!props.open && (
        <div className="mb-1 flex shrink-0 gap-1">
          <RailIconButton icon={PanelLeft} label="Show chat history" onClick={() => props.onOpenChange(true)} />
          <RailIconButton icon={MessageSquarePlus} label="New chat" onClick={props.onNewChat} />
        </div>
      )}
      <div className="no-scrollbar mt-1 flex min-h-0 w-full flex-1 flex-col gap-0.5 overflow-y-auto">
        {RAIL_GROUPS.map((group, index) => (
          <Fragment key={group}>
            {index > 0 && <RailDivider />}
            {TABS.filter((item) => item.group === group).map((item) => (
              <RailButton key={item.id} icon={item.icon} label={item.short} active={props.tab === item.id} onClick={() => props.onTabChange(item.id)} />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="mt-2 flex w-full shrink-0 flex-col items-center gap-0.5 border-t border-border/60 pt-2">
        <RailButton icon={Database} label="Sources" onClick={props.onOpenSources} />
        <RailButton icon={Settings} label="Settings" onClick={props.onOpenWorkspaceSettings} />
        <AccountMenu
          compact
          user={props.user}
          onOpenPalette={props.onOpenPalette}
          onOpenShortcuts={props.onOpenShortcuts}
          onOpenSettings={props.onOpenWorkspaceSettings}
          onLogout={props.onLogout}
        />
      </div>
    </nav>
  )
}

function ChatSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex h-8 items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 transition-colors focus-within:border-primary/50">
      <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="sr-only">Search chats</span>
      <input
        type="search"
        value={value}
        maxLength={LIMITS.explorerSearchChars}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onChange('')}
        placeholder="Search chats"
        className="w-full bg-transparent text-[13px] placeholder:text-muted-foreground focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      )}
    </label>
  )
}

/** Workspace and notebook pickers on top, then new chat, search and the chat history. */
function HistoryPanel(props: AppSidebarProps) {
  const [search, setSearch] = useState('')
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)

  return (
    <aside
      aria-label="Chat history"
      inert={!props.open}
      className={cn(
        'h-full shrink-0 overflow-hidden border-r border-border/60 bg-card transition-[width] duration-300 ease-smooth',
        props.open ? 'w-[272px]' : 'w-[272px] lg:w-0 lg:border-r-0',
      )}
    >
      <div className="flex h-full w-[272px] flex-col">
        <div className="flex items-center gap-1 px-2 pb-1 pt-2">
          <WorkspaceMenu onSelect={props.onSelectWorkspace} onCreate={() => setCreatingWorkspace(true)} onOpenSettings={props.onOpenWorkspaceSettings} />
          <button
            type="button"
            aria-label="Hide chat history"
            title="Hide chat history"
            onClick={() => props.onOpenChange(false)}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <PanelLeftClose className="size-4" />
          </button>
        </div>
        {creatingWorkspace && (
          <div className="px-3 pb-2">
            <InlineNameForm
              initial=""
              label="Team workspace name"
              maxLength={LIMITS.workspaceNameChars}
              onSave={props.onCreateWorkspace}
              onCancel={() => setCreatingWorkspace(false)}
            />
          </div>
        )}

        <div className="px-3 pb-2">
          <NotebookPicker
            collections={props.collections}
            selected={props.selected}
            onSelect={props.onSelect}
            onCreate={props.onCreateCollection}
            onRename={props.onRenameCollection}
            onDelete={props.onDeleteCollection}
            onManageAccess={props.onManageCollectionAccess}
          />
        </div>

        <div className="space-y-2 border-b border-border/50 px-3 pb-3">
          <button
            type="button"
            onClick={props.onNewChat}
            className="flex w-full items-center gap-2 rounded-lg bg-brand-gradient px-3 py-2 text-[13px] font-semibold text-white shadow-sm transition-all hover:shadow-md active:scale-[0.98]"
          >
            <MessageSquarePlus className="size-4" />
            New chat
          </button>
          <ChatSearch value={search} onChange={setSearch} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Conversations">
          <HistoryList
            search={search.trim()}
            conversations={props.conversations}
            loading={props.conversationsLoading}
            actions={{
              activeId: props.activeConversationId,
              onOpen: props.onSelectConversation,
              onDelete: props.onDeleteConversation,
              onRename: props.onRenameConversation,
              onPin: props.onPinConversation,
            }}
          />
        </div>
      </div>
    </aside>
  )
}

/**
 * ChatGPT-style navigation: a narrow rail with every view (always visible on desktop) and a panel
 * that is mostly chat history — grouped by date, searchable across all chats. Workspace and notebook
 * pickers sit compactly at the top of the panel. On small screens both slide in as one drawer.
 */
export function AppSidebar(props: AppSidebarProps) {
  const { open, onOpenChange } = props
  return (
    <>
      {open && <div aria-hidden onClick={() => onOpenChange(false)} className="fixed inset-0 z-30 animate-fade-in bg-background/60 backdrop-blur-sm lg:hidden" />}
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex h-full shrink-0 transition-transform duration-300 ease-smooth lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <NavigationRail {...props} />
        <HistoryPanel {...props} />
      </div>
    </>
  )
}
