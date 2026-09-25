'use client'

import {
  AlertTriangle,
  BookOpenText,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Github,
  Globe,
  HardDrive,
  Loader2,
  NotebookText,
  RotateCcw,
  ScanText,
  Search,
  Trash2,
  Youtube,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { IngestionHub, type IngestionTab } from '@/components/ingestion-hub'
import { Drawer } from '@/components/ui/drawer'
import { EmptyState, Progress, Skeleton } from '@/components/ui/feedback-primitives'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useDocuments } from '@/hooks/use-api'
import type { useUploads } from '@/hooks/use-uploads'
import { apiJson, errorMessage } from '@/lib/api-client'
import { CONNECTOR_LABELS } from '@/lib/constants'
import type { Collection, DocumentSummary, MediaKind, SourceType } from '@/lib/contracts'
import { formatBytes, plural, timeAgo } from '@/lib/format'
import { atLeast } from '@/lib/roles'
import { cn } from '@/lib/utils'

const ICONS: Record<SourceType, typeof FileText> = {
  file: FileText,
  text: FileText,
  url: Globe,
  youtube: Youtube,
  google_drive: HardDrive,
  notion: NotebookText,
  github: Github,
  website: Globe,
}

const MEDIA_ICONS: Record<MediaKind, typeof FileText> = { image: FileImage, audio: FileAudio, video: FileVideo, scan: ScanText }

const ORIGIN: Partial<Record<SourceType, string>> = CONNECTOR_LABELS

function processingLabel(document: DocumentSummary): string {
  if (document.progress) return document.progress
  return `Indexing${document.totalChunks ? ` ${document.chunkCount} / ${document.totalChunks} passages` : '…'}`
}

interface SourcesPanelProps {
  open: boolean
  onClose: () => void
  collections: Collection[]
  /** Notebook the drawer shows and adds to. */
  target: string | null
  onTargetChange: (collectionId: string) => void
  disabled?: boolean
  onChanged: () => void
  onOpenDocument: (documentId: string) => void
  uploads: ReturnType<typeof useUploads>
  /** Document to scroll to and highlight (e.g. from a notification). */
  highlightId?: string | null
  /** Which add-source tab to show; a new `hubKey` re-applies it. */
  hubTab?: IngestionTab
  hubKey?: number
}

function DocumentRow({
  document,
  canEdit,
  highlighted,
  onOpen,
  onRemove,
  onRetry,
}: {
  document: DocumentSummary
  canEdit: boolean
  highlighted: boolean
  onOpen: () => void
  onRemove: () => void
  onRetry: () => void
}) {
  const Icon = document.mediaKind ? MEDIA_ICONS[document.mediaKind] : ICONS[document.sourceType]
  // While media is being read the stage is unknown in length; indexing shows real progress.
  const progress = document.progress ? null : document.totalChunks ? document.chunkCount / document.totalChunks : null
  const origin = ORIGIN[document.sourceType]
  return (
    <li
      id={`document-${document.id}`}
      className={cn(
        'group rounded-xl border bg-card/60 px-3 py-2.5 text-xs transition-all',
        highlighted ? 'border-primary/60 ring-4 ring-primary/10' : 'border-border/60 hover:border-primary/30',
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', document.status === 'failed' ? 'bg-destructive/10' : 'bg-brand-soft')}>
          {document.status === 'processing' ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : document.status === 'failed' ? (
            <AlertTriangle className="size-4 text-destructive" />
          ) : (
            <Icon className="size-4 text-primary" />
          )}
        </div>
        <button type="button" onClick={onOpen} disabled={document.status !== 'ready'} className="min-w-0 flex-1 text-left disabled:cursor-default">
          <p className="truncate font-medium text-foreground group-hover:text-primary" title={document.source}>
            {document.title}
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {document.status === 'processing'
              ? processingLabel(document)
              : document.status === 'failed'
                ? 'Could not be added'
                : `${origin ? `${origin} · ` : ''}${plural(document.chunkCount, 'passage')}${document.byteSize ? ` · ${formatBytes(document.byteSize)}` : ''} · ${timeAgo(document.createdAt)}`}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
          {document.status === 'ready' && (
            <button
              type="button"
              aria-label={`Read ${document.title}`}
              title="Read the document"
              onClick={onOpen}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <BookOpenText className="size-3.5" />
            </button>
          )}
          {canEdit && document.status === 'failed' && (
            <button
              type="button"
              aria-label={`Retry ${document.title}`}
              title="Retry indexing"
              onClick={onRetry}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <RotateCcw className="size-3.5" />
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              aria-label={`Remove ${document.title}`}
              title="Remove"
              onClick={onRemove}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      {document.status === 'processing' && <Progress value={progress} className="mt-2" label={`${processingLabel(document)}: ${document.title}`} />}
      {document.status === 'failed' && document.error && <p className="mt-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{document.error}</p>}
    </li>
  )
}

export function SourcesPanel({ open, onClose, collections, target, onTargetChange, disabled, onChanged, onOpenDocument, uploads, highlightId, hubTab, hubKey }: SourcesPanelProps) {
  const { toast } = useToast()
  const [filter, setFilter] = useState('')
  const documents = useDocuments(target)
  const list = documents.data?.documents ?? []
  const visible = filter ? list.filter((document) => document.title.toLowerCase().includes(filter.toLowerCase())) : list
  const targetCollection = collections.find((c) => c.id === target)
  const targetName = targetCollection?.name ?? 'notebook'
  const canEdit = atLeast(targetCollection?.myRole, 'editor')
  const canClear = targetCollection?.myRole === 'admin'
  const indexing = list.filter((document) => document.status === 'processing').length

  // Files uploaded from the drawer or dropped anywhere on the page: list them at once (the list then
  // polls while they index).
  const { mutate: mutateDocuments } = documents
  const uploadedIds = uploads.items.map((item) => item.document?.id ?? '').join(',')
  useEffect(() => {
    if (uploadedIds.replaceAll(',', '')) void mutateDocuments()
  }, [uploadedIds, mutateDocuments])

  // Refresh the notebook counts when background indexing finishes.
  const previousIndexing = useRef(0)
  useEffect(() => {
    if (indexing < previousIndexing.current) onChanged()
    previousIndexing.current = indexing
  }, [indexing, onChanged])

  useEffect(() => {
    if (!open || !highlightId || !documents.data) return
    document.getElementById(`document-${highlightId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [open, highlightId, documents.data])

  function refresh() {
    void documents.mutate()
    onChanged()
  }

  async function run(action: () => Promise<void>) {
    try {
      await action()
      refresh()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    }
  }

  const remove = (document: DocumentSummary) => {
    if (!window.confirm(`Remove "${document.title}" and all of its passages?`)) return
    void run(async () => {
      await apiJson(`/api/corpus/documents/${document.id}`, { method: 'DELETE' })
      toast({ description: `Removed "${document.title}".` })
    })
  }

  const retry = (document: DocumentSummary) =>
    void run(async () => {
      await apiJson(`/api/corpus/documents/${document.id}/retry`, { method: 'POST' })
      toast({ description: `Indexing “${document.title}” again.` })
    })

  const clearNotebook = () => {
    if (!target || !window.confirm(`Remove every source from "${targetName}"? This cannot be undone.`)) return
    void run(async () => {
      const { deleted } = await apiJson<{ deleted: number }>(`/api/corpus?collectionId=${encodeURIComponent(target)}`, { method: 'DELETE' })
      toast({ description: `Removed ${deleted} source${deleted === 1 ? '' : 's'}.` })
    })
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Sources"
      description={
        <span>
          {list.length} source{list.length === 1 ? '' : 's'} in “{targetName}”{indexing ? ` · ${indexing} indexing` : ''}
        </span>
      }
    >
      <div className="border-b border-border/50 px-4 pt-4">
        <label htmlFor="sources-target" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Notebook
        </label>
        <Select id="sources-target" value={target ?? ''} onChange={(event) => onTargetChange(event.target.value)} disabled={collections.length === 0}>
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </Select>
      </div>

      {/* One scroll area: the add-source tabs (Apps can be tall) and the list move together. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {target && !canEdit ? (
          <p className="border-b border-border/50 p-4 text-xs text-muted-foreground">
            You have view-only access to “{targetName}”. Ask a workspace admin for Editor access to add sources.
          </p>
        ) : (
          <IngestionHub key={hubKey} initialTab={hubTab} collectionId={target} disabled={disabled} onIngested={refresh} uploads={uploads} />
        )}

        <div className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Indexed sources</p>
            {list.length > 0 && canClear && (
              <button type="button" onClick={clearNotebook} className="text-[10px] text-muted-foreground hover:text-destructive">
                Clear notebook
              </button>
            )}
          </div>
          {list.length > 5 && (
            <label className="composer mb-3 flex items-center gap-2 px-3 py-1.5">
              <Search className="size-3.5 text-muted-foreground" />
              <span className="sr-only">Filter sources</span>
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter sources…"
                className="w-full bg-transparent text-xs focus:outline-none"
              />
            </label>
          )}
          {documents.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((key) => (
                <Skeleton key={key} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : documents.error ? (
            <p className="py-6 text-center text-xs text-destructive">{errorMessage(documents.error)}</p>
          ) : list.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No sources yet"
              description="Add files, connect an app, or add a web page, a YouTube video or pasted text above. Everything is indexed in the background."
            />
          ) : (
            <ul className="stagger space-y-2">
              {visible.map((document) => (
                <DocumentRow
                  key={document.id}
                  document={document}
                  canEdit={canEdit}
                  highlighted={document.id === highlightId}
                  onOpen={() => onOpenDocument(document.id)}
                  onRemove={() => remove(document)}
                  onRetry={() => retry(document)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Drawer>
  )
}
