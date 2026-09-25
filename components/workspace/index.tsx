'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { AppSidebar } from '@/components/app-sidebar'
import { SessionExpiredModal } from '@/components/auth-modal'
import { CommandPalette } from '@/components/command-palette'
import { DropOverlay } from '@/components/drop-overlay'
import { acceptFiles } from '@/components/file-upload-zone'
import type { IngestionTab } from '@/components/ingestion-hub'
import { NotebookAccessDrawer } from '@/components/notebook-access'
import { OnboardingChecklist } from '@/components/onboarding-checklist'
import { ShareDialog } from '@/components/share-dialog'
import { ShortcutsDialog } from '@/components/shortcuts-dialog'
import { SourceViewer } from '@/components/source-viewer'
import { SourcesPanel } from '@/components/sources-panel'
import { useToast } from '@/components/ui/use-toast'
import { WorkspaceProvider, useWorkspaceContext } from '@/components/workspace-provider'
import { WorkspaceSettingsDrawer } from '@/components/workspace-settings'
import { useCollections, useConversations, useImages, useReports, useStats } from '@/hooks/use-api'
import { useErrorToast } from '@/hooks/use-error-toast'
import { useHotkeys, useModKeyLabel } from '@/hooks/use-hotkeys'
import { useRagChat } from '@/hooks/use-rag-chat'
import { useTheme } from '@/hooks/use-theme'
import { useUploads } from '@/hooks/use-uploads'
import { apiJson, errorMessage, onSessionExpired } from '@/lib/api-client'
import type { ChatMode } from '@/lib/constants'
import type { DocumentDetail, DocumentSummary, NotificationItem, SessionUser, WorkspaceSummary } from '@/lib/contracts'
import { workspaceName } from '@/lib/format'
import { atLeast } from '@/lib/roles'

import { buildCommands, buildOnboardingSteps } from './commands'
import { describeScope, onboardingProgress, readFeatures } from './derived'
import { TABS, tabLabel, type WorkspaceTab } from './navigation'
import { useConversationActions } from './use-conversation-actions'
import { useHistoryPanel } from './use-history-panel'
import { useNotebookActions } from './use-notebook-actions'
import { useUrlState } from './use-url-state'
import { SetupBanners, WorkspaceContent } from './workspace-content'
import { WorkspaceHeader } from './workspace-header'

function focusComposer() {
  window.document.getElementById('chat-input')?.focus()
}

export function Workspace({ user }: { user: SessionUser }) {
  return (
    <WorkspaceProvider>
      <WorkspaceShell user={user} />
    </WorkspaceProvider>
  )
}

/**
 * Client shell: layout and orchestration only. Data comes from SWR hooks and chat from useRagChat;
 * each concern lives in its own hook (history panel, URL state, conversation and notebook actions)
 * or component (header, content, sidebar).
 */
function WorkspaceShell({ user }: { user: SessionUser }) {
  const router = useRouter()
  const { toast } = useToast()
  const fail = useErrorToast()
  const workspace = useWorkspaceContext()
  const { setTheme } = useTheme()
  const mod = useModKeyLabel()
  const history = useHistoryPanel()

  const [tab, setTab] = useState<WorkspaceTab>('chat')
  const [selected, setSelected] = useState('all')
  const [mode, setMode] = useState<ChatMode>('standard')
  const [sources, setSources] = useState<{ open: boolean; target: string | null; highlight: string | null; tab: IngestionTab; key: number }>({
    open: false,
    target: null,
    highlight: null,
    tab: 'files',
    key: 0,
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [accessFor, setAccessFor] = useState<string | null>(null)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [viewer, setViewer] = useState<{ documentId: string; chunkId: string | null } | null>(null)
  const [imageDraft, setImageDraft] = useState<{ prompt: string; collectionId: string | null } | null>(null)
  const [focus, setFocus] = useState<{ tab: WorkspaceTab; id: string } | null>(null)

  const collections = useCollections()
  const conversations = useConversations()
  const stats = useStats()
  const reports = useReports()
  const images = useImages()
  const refreshConversations = conversations.mutate
  const chat = useRagChat({ onConversationCreated: () => void refreshConversations(), onSettled: () => void refreshConversations() })

  const collectionList = useMemo(() => collections.data?.collections ?? [], [collections.data])
  const conversationList = conversations.data?.conversations ?? []

  const refreshCorpus = useCallback(() => {
    void collections.mutate()
    void stats.mutate()
  }, [collections, stats])

  const onUploaded = useCallback(
    (document: DocumentSummary) => {
      toast({ title: 'Uploaded', description: `“${document.title}” is being indexed in the background.` })
      refreshCorpus()
    },
    [toast, refreshCorpus],
  )
  const uploads = useUploads(onUploaded)

  useEffect(() => onSessionExpired(() => setSessionExpired(true)), [])
  useEffect(() => {
    if (selected !== 'all' && collections.data && !collections.data.collections.some((c) => c.id === selected)) setSelected('all')
  }, [collections.data, selected])

  // The Sources drawer follows the notebook picked in the sidebar and always points at one that exists.
  useEffect(() => {
    if (selected !== 'all') setSources((current) => ({ ...current, target: selected }))
  }, [selected])
  useEffect(() => {
    if (collectionList.length > 0 && !collectionList.some((c) => c.id === sources.target)) setSources((current) => ({ ...current, target: collectionList[0]!.id }))
  }, [collectionList, sources.target])

  const active = workspace.active
  const { scope, scopeLabel, chunkCount } = describeScope(collectionList, selected, stats.data)
  const features = readFeatures(stats.data)
  const activeConversation = conversationList.find((c) => c.id === chat.conversationId) ?? null

  const { closeOnMobile } = history
  const showTab = useCallback(
    (next: WorkspaceTab) => {
      setTab(next)
      closeOnMobile()
    },
    [closeOnMobile],
  )
  const onConversationOpened = useCallback(
    (notebookId: string | null) => {
      setSelected(notebookId ?? 'all')
      showTab('chat')
    },
    [showTab],
  )
  const conversationActions = useConversationActions({ chat, refreshConversations, collections: collectionList, onOpened: onConversationOpened })
  const notebookActions = useNotebookActions({ collections: collectionList, refreshCollections: collections.mutate, refreshCorpus, select: setSelected })

  function openSources(target?: string | null, highlight?: string | null, hubTab: IngestionTab = 'files') {
    setSources((current) => ({ open: true, target: target ?? current.target, highlight: highlight ?? null, tab: hubTab, key: Date.now() }))
  }

  const onDriveReturn = useCallback(
    (result: string) => {
      setSources((current) => ({ ...current, open: true, tab: 'apps', key: Date.now() }))
      if (result === 'connected') toast({ title: 'Google Drive connected', description: 'Choose files or folders to add with “Add”.' })
      else toast({ variant: 'destructive', description: result === 'denied' ? 'Google Drive access was not granted.' : 'Google Drive could not be connected. Try again.' })
    },
    [toast],
  )
  useUrlState({ tab, setTab, conversationId: chat.conversationId, openConversation: conversationActions.open, collectionsLoaded: Boolean(collections.data), onDriveReturn })

  /** Conversations, notebooks and chats belong to one workspace, so switching starts fresh. */
  function switchWorkspace(id: string) {
    if (id === active?.id) return
    chat.reset()
    setSelected('all')
    setAccessFor(null)
    setViewer(null)
    workspace.select(id)
  }

  async function createWorkspace(name: string): Promise<boolean> {
    try {
      const { workspace: created } = await apiJson<{ workspace: WorkspaceSummary }>('/api/workspaces', { method: 'POST', json: { name }, workspaceId: null })
      await workspace.refresh()
      switchWorkspace(created.id)
      setSettingsOpen(true)
      toast({ description: `Created “${created.name}”. Add members to start collaborating.` })
      return true
    } catch (error) {
      fail(error)
      return false
    }
  }

  /** Signing out revokes the session on the server; `everywhere` revokes every session of the account. */
  async function logout(options: { everywhere?: boolean } = {}) {
    if (options.everywhere && !window.confirm('Sign out of every browser and device where this account is signed in?')) return
    await apiJson(options.everywhere ? '/api/auth?scope=all' : '/api/auth', { method: 'DELETE' }).catch(() => undefined)
    router.replace('/login')
    router.refresh()
  }

  function newChat() {
    chat.reset()
    showTab('chat')
    requestAnimationFrame(focusComposer)
  }

  const openSource = (documentId: string, chunkId?: string | null) => setViewer({ documentId, chunkId: chunkId ?? null })

  // Dropped files go to the notebook open in the Sources drawer or the sidebar, else the first one you can edit.
  const canEdit = (id: string | null) => id !== null && atLeast(collectionList.find((c) => c.id === id)?.myRole, 'editor')
  const dropTarget = [sources.target, selected === 'all' ? null : selected, ...collectionList.map((c) => c.id)].find(canEdit) ?? null

  function dropFiles(list: FileList) {
    if (!dropTarget) {
      toast({ variant: 'destructive', description: 'You need Editor access to a notebook to add sources.' })
      return
    }
    const files = acceptFiles(list, (message) => toast({ variant: 'destructive', description: message }))
    if (files.length === 0) return
    openSources(dropTarget)
    void uploads.upload(files, dropTarget)
  }

  /** A notification leads to what it is about: a source, or an item on its tab. */
  async function followNotification(item: NotificationItem) {
    if (item.workspaceId && item.workspaceId !== active?.id && workspace.workspaces.some((w) => w.id === item.workspaceId)) switchWorkspace(item.workspaceId)
    const link = item.link
    if (!link) return
    if (link.tab !== 'sources') {
      setTab(link.tab)
      if (link.id) setFocus({ tab: link.tab, id: link.id })
      return
    }
    // Sync notifications lead to the connected apps; others to the source list.
    if (!link.id) return openSources(null, null, item.kind.startsWith('sync_') ? 'apps' : 'files')
    try {
      const { document } = await apiJson<DocumentDetail>(`/api/corpus/documents/${link.id}`)
      if (document.status === 'ready') openSource(document.id)
      else openSources(document.collectionId, document.id)
    } catch (error) {
      fail(error)
    }
  }

  useHotkeys([
    { combo: 'mod+k', handler: () => setPaletteOpen((open) => !open), inInputs: true },
    { combo: 'mod+b', handler: () => history.change(!history.open), inInputs: true },
    {
      combo: 'mod+/',
      handler: () => {
        setTab('chat')
        requestAnimationFrame(focusComposer)
      },
      inInputs: true,
    },
    { combo: 'shift+?', handler: () => setShortcutsOpen(true) },
    ...TABS.map(({ id }, index) => ({ combo: `alt+${index + 1}`, handler: () => setTab(id), inInputs: true })),
  ])

  const commands = buildCommands({
    mode,
    conversations: conversationList,
    collections: collectionList,
    workspaces: workspace.workspaces,
    activeWorkspaceId: active?.id ?? null,
    showTab: setTab,
    newChat,
    openSources: (hubTab) => openSources(null, null, hubTab),
    setMode,
    openSettings: () => setSettingsOpen(true),
    openConversation: (id) => void conversationActions.open(id),
    selectNotebook: setSelected,
    switchWorkspace,
    setTheme,
    openShortcuts: () => setShortcutsOpen(true),
    signOut: () => void logout(),
  })

  const onboarding = buildOnboardingSteps({
    ...onboardingProgress({ stats: stats.data, conversations: conversationList, reports: reports.data?.reports, images: images.data?.images, workspaces: workspace.workspaces }),
    openSources: () => openSources(),
    focusComposer,
    showTab: setTab,
    inviteTeam: () => {
      if (!active?.isPersonal) return setSettingsOpen(true)
      history.change(true)
      toast({ description: 'Open the workspace menu at the top of the sidebar, choose “New team workspace”, then add members.' })
    },
  })

  return (
    <div className="flex h-screen overflow-hidden text-foreground">
      <SessionExpiredModal open={sessionExpired} />

      <AppSidebar
        open={history.open}
        onOpenChange={history.change}
        user={user}
        tab={tab}
        onTabChange={showTab}
        collections={collectionList}
        selected={selected}
        onSelect={setSelected}
        onCreateCollection={notebookActions.create}
        onRenameCollection={notebookActions.rename}
        onDeleteCollection={(id) => void notebookActions.remove(id)}
        onManageCollectionAccess={setAccessFor}
        onSelectWorkspace={switchWorkspace}
        onCreateWorkspace={createWorkspace}
        onOpenWorkspaceSettings={() => {
          setSettingsOpen(true)
          history.closeOnMobile()
        }}
        onOpenSources={() => {
          openSources()
          history.closeOnMobile()
        }}
        conversations={conversationList}
        conversationsLoading={!conversations.data && !conversations.error}
        activeConversationId={chat.conversationId}
        onSelectConversation={(id) => void conversationActions.open(id)}
        onNewChat={newChat}
        onDeleteConversation={(id) => void conversationActions.remove(id)}
        onRenameConversation={conversationActions.rename}
        onPinConversation={(id, pinned) => void conversationActions.pin(id, pinned)}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onLogout={(options) => void logout(options)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader
          title={tab === 'chat' && activeConversation ? activeConversation.title : tabLabel(tab)}
          subtitle={`${active ? workspaceName(active) : 'Loading…'} · ${scopeLabel}`}
          historyOpen={history.open}
          onOpenNavigation={() => history.change(true)}
          modKey={mod}
          onOpenPalette={() => setPaletteOpen(true)}
          chatActions={
            tab === 'chat' && chat.messages.length > 0
              ? {
                  conversation: activeConversation,
                  onPin: (pinned) => activeConversation && void conversationActions.pin(activeConversation.id, pinned),
                  onShare: () => setSharing(true),
                  onExport: conversationActions.exportChat,
                  onDelete: () => activeConversation && void conversationActions.remove(activeConversation.id),
                }
              : null
          }
          activeWorkspaceId={active?.id ?? null}
          onNotification={(item) => void followNotification(item)}
          passageCount={chunkCount}
          onOpenSources={() => openSources()}
        />

        <SetupBanners schemaReady={features.schema} aiReady={features.ai} />

        <WorkspaceContent
          tab={tab}
          ready={Boolean(active)}
          loadError={workspace.error ? errorMessage(workspace.error) : null}
          user={user}
          chat={chat}
          mode={mode}
          onModeChange={setMode}
          collections={collectionList}
          selected={selected}
          scopeLabel={scopeLabel}
          chunkCount={chunkCount}
          totals={stats.data?.totals}
          features={features}
          focus={focus}
          onFocusConsumed={() => setFocus(null)}
          imageDraft={imageDraft}
          onImageDraftConsumed={() => setImageDraft(null)}
          onboarding={<OnboardingChecklist steps={onboarding} />}
          onSend={(text) => void chat.send(text, { collectionId: scope?.id ?? null, mode })}
          onBranch={(messageId) => void conversationActions.branch(messageId)}
          onFeedback={conversationActions.rate}
          onVisualize={(question) => {
            setImageDraft({ prompt: question, collectionId: scope?.id ?? null })
            setTab('images')
          }}
          onAskInChat={(question) => {
            setTab('chat')
            void chat.send(question, { collectionId: scope?.id ?? null, mode })
          }}
          onOpenSource={openSource}
          onAddSources={() => openSources()}
          onCorpusChanged={refreshCorpus}
        />
      </div>

      <SourcesPanel
        open={sources.open}
        onClose={() => setSources((current) => ({ ...current, open: false }))}
        collections={collectionList}
        target={sources.target}
        onTargetChange={(target) => setSources((current) => ({ ...current, target }))}
        disabled={!features.ai || !features.schema}
        onChanged={refreshCorpus}
        onOpenDocument={(documentId) => openSource(documentId)}
        uploads={uploads}
        highlightId={sources.highlight}
        hubTab={sources.tab}
        hubKey={sources.key}
      />
      <SourceViewer documentId={viewer?.documentId ?? null} chunkId={viewer?.chunkId} onClose={() => setViewer(null)} />
      <WorkspaceSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        user={user}
        onLeft={() => {
          chat.reset()
          setSelected('all')
        }}
      />
      <NotebookAccessDrawer collection={collectionList.find((c) => c.id === accessFor) ?? null} onClose={() => setAccessFor(null)} onChanged={() => void collections.mutate()} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ShareDialog
        open={sharing && activeConversation !== null}
        onClose={() => setSharing(false)}
        kind="conversation"
        targetId={activeConversation?.id ?? null}
        title={activeConversation?.title ?? ''}
        canShare={atLeast(workspace.role, 'editor')}
      />
      <DropOverlay enabled={Boolean(active) && features.ai && features.schema} targetName={collectionList.find((c) => c.id === dropTarget)?.name ?? null} onDrop={dropFiles} />
    </div>
  )
}
