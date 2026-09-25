'use client'

import { AlertCircle, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { AnalyticsDashboard } from '@/components/analytics-dashboard'
import { AudioStudio } from '@/components/audio-studio'
import { ChatPanel } from '@/components/chat-panel'
import { ChunkExplorer } from '@/components/chunk-explorer'
import { ImageStudio } from '@/components/image-studio'
import { MindMapStudio } from '@/components/mindmap-studio'
import { ReportsPanel } from '@/components/reports-panel'
import type { useRagChat } from '@/hooks/use-rag-chat'
import type { ChatMode } from '@/lib/constants'
import type { Collection, SessionUser, StatsResponse } from '@/lib/contracts'

import type { WorkspaceTab } from './navigation'

/** Server set-up problems shown above every view. */
export function SetupBanners({ schemaReady, aiReady }: { schemaReady: boolean; aiReady: boolean }) {
  const banner = (children: ReactNode) => (
    <div role="status" className="flex animate-slide-down items-start gap-3 border-b border-warning/25 bg-warning/10 px-6 py-3 text-sm">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="text-foreground/85">{children}</div>
    </div>
  )
  if (!schemaReady) {
    return banner(
      <>
        The database schema is out of date. Run <code className="rounded bg-background/60 px-1 font-mono text-xs">npm run db:migrate</code> on the server.
      </>,
    )
  }
  if (!aiReady) return banner('The AI provider is not configured on the server (GOOGLE_API_KEY), so chat and indexing are disabled.')
  return null
}

export interface WorkspaceContentProps {
  tab: WorkspaceTab
  ready: boolean
  loadError: string | null
  user: SessionUser
  chat: ReturnType<typeof useRagChat>
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  collections: Collection[]
  /** Notebook picked in the sidebar ('all' or an id), and its display name for the chat. */
  selected: string
  scopeLabel: string
  chunkCount: number
  totals: StatsResponse['totals'] | undefined
  features: { ai: boolean; schema: boolean; images: boolean; audio: boolean }
  /** An item to open on its tab (from a notification), and a way to say it was opened. */
  focus: { tab: WorkspaceTab; id: string } | null
  onFocusConsumed: () => void
  imageDraft: { prompt: string; collectionId: string | null } | null
  onImageDraftConsumed: () => void
  onboarding: ReactNode
  onSend: (text: string) => void
  onBranch: (messageId: string) => void
  onFeedback: (messageId: string, rating: 1 | -1 | 0, comment?: string) => Promise<void>
  onVisualize: (question: string) => void
  onAskInChat: (question: string) => void
  onOpenSource: (documentId: string, chunkId?: string | null) => void
  onAddSources: () => void
  onCorpusChanged: () => void
}

/** The view of the current tab. */
export function WorkspaceContent(props: WorkspaceContentProps) {
  if (!props.ready) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {props.loadError ? <p className="text-destructive">{props.loadError}</p> : <Loader2 className="size-6 animate-spin text-primary" />}
      </div>
    )
  }
  const { tab, user, collections, features } = props
  const enabled = features.ai && features.schema
  const focusId = (on: WorkspaceTab) => (props.focus?.tab === on ? props.focus.id : null)
  const panel = (children: ReactNode) => (
    <div key={tab} className="min-h-0 flex-1 animate-fade-up p-3 sm:p-5">
      <section className="panel h-full p-4 sm:p-6">{children}</section>
    </div>
  )

  switch (tab) {
    case 'chat':
      return (
        <ChatPanel
          messages={props.chat.messages}
          isStreaming={props.chat.isStreaming}
          disabled={!enabled}
          scopeLabel={props.scopeLabel}
          chunkCount={props.chunkCount}
          mode={props.mode}
          onModeChange={props.onModeChange}
          user={user}
          onSend={props.onSend}
          onStop={props.chat.stop}
          onBranch={props.onBranch}
          onFeedback={props.onFeedback}
          onVisualize={props.onVisualize}
          onOpenSource={props.onOpenSource}
          onAddSources={props.onAddSources}
          onboarding={props.onboarding}
        />
      )
    case 'explorer':
      return panel(<ChunkExplorer collections={collections} selected={props.selected} onChanged={props.onCorpusChanged} />)
    case 'reports':
      return panel(<ReportsPanel collections={collections} user={user} focusId={focusId('reports')} onFocusConsumed={props.onFocusConsumed} />)
    case 'images':
      return panel(
        <ImageStudio
          collections={collections}
          user={user}
          imagesEnabled={features.images && enabled}
          draft={props.imageDraft}
          onDraftConsumed={props.onImageDraftConsumed}
          focusId={focusId('images')}
          onFocusConsumed={props.onFocusConsumed}
          onOpenSource={props.onOpenSource}
        />,
      )
    case 'audio':
      return panel(
        <AudioStudio
          collections={collections}
          user={user}
          audioEnabled={features.audio && enabled}
          focusId={focusId('audio')}
          onFocusConsumed={props.onFocusConsumed}
          onOpenSource={(documentId) => props.onOpenSource(documentId)}
        />,
      )
    case 'mindmaps':
      return panel(
        <MindMapStudio
          collections={collections}
          user={user}
          enabled={enabled}
          focusId={focusId('mindmaps')}
          onFocusConsumed={props.onFocusConsumed}
          onAsk={props.onAskInChat}
          onOpenSource={(documentId) => props.onOpenSource(documentId)}
        />,
      )
    case 'analytics':
      return panel(<AnalyticsDashboard totals={props.totals} collections={collections} />)
  }
}
