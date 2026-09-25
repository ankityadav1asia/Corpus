'use client'

import { Binary, ChevronLeft, ChevronRight, Database, FileText, Loader2, Pencil, Plus, RefreshCw, Save, Search, Tag, Trash2, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { useChunkDetail, useChunks } from '@/hooks/use-api'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { apiJson, errorMessage } from '@/lib/api-client'
import { LIMITS } from '@/lib/constants'
import type { ChunkMetadataValue, ChunkRow, Collection } from '@/lib/contracts'
import { atLeast } from '@/lib/roles'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 15
const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.:-]*$/u
const METADATA_KEY_PATTERN = /^[A-Za-z0-9_.-]+$/

type MetadataRow = { key: string; value: string }

/** "Finance, q3 ,finance" → ["finance", "q3"]; returns an error message for invalid input. */
function parseLabels(input: string): { labels: string[]; error: string | null } {
  const labels = [
    ...new Set(
      input
        .split(',')
        .map((label) => label.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  const invalid = labels.find((label) => label.length > LIMITS.labelChars || !LABEL_PATTERN.test(label))
  if (invalid) return { labels, error: `“${invalid}” is not a valid label (letters, numbers, spaces and _ . : - only).` }
  if (labels.length > LIMITS.labelsPerChunk) return { labels, error: `At most ${LIMITS.labelsPerChunk} labels per chunk.` }
  return { labels, error: null }
}

/** Keeps the original number/boolean type of values that were not edited. */
function buildMetadata(rows: MetadataRow[], original: Record<string, ChunkMetadataValue>): { metadata: Record<string, ChunkMetadataValue>; error: string | null } {
  const metadata: Record<string, ChunkMetadataValue> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key && !row.value) continue
    if (!METADATA_KEY_PATTERN.test(key) || key.length > 40) return { metadata, error: `“${key || '(empty)'}” is not a valid metadata key (letters, numbers, _ . - only).` }
    if (row.value.length > LIMITS.metadataValueChars) return { metadata, error: `The value of “${key}” is too long.` }
    const previous = original[key]
    metadata[key] = previous !== undefined && String(previous) === row.value ? previous : row.value
  }
  if (Object.keys(metadata).length > LIMITS.metadataKeysPerChunk) return { metadata, error: `At most ${LIMITS.metadataKeysPerChunk} metadata fields.` }
  return { metadata, error: null }
}

function VectorSummary({ chunkId }: { chunkId: string }) {
  const detail = useChunkDetail(chunkId)
  if (detail.isLoading) return <Loader2 className="size-3.5 animate-spin text-primary" />
  if (detail.error || !detail.data) return <p className="text-[11px] text-destructive">{errorMessage(detail.error)}</p>
  const { embedding } = detail.data.chunk
  return (
    <div className="rounded-lg border border-border/60 bg-secondary/30 p-2.5 font-mono text-[10px] text-muted-foreground">
      <p>
        {embedding.dimensions.toLocaleString()} dimensions · L2 norm {embedding.norm}
      </p>
      <p className="mt-1 break-all text-foreground/70">[{embedding.preview.join(', ')}, …]</p>
      <p className="mt-1">Stored in the same row as the text, so edits update both together.</p>
    </div>
  )
}

interface ChunkCardProps {
  chunk: ChunkRow
  notebookName: string
  canEdit: boolean
  onFilterLabel: (label: string) => void
  onChanged: () => Promise<void>
}

function ChunkCard({ chunk, notebookName, canEdit, onFilterLabel, onChanged }: ChunkCardProps) {
  const { toast } = useToast()
  const [mode, setMode] = useState<'view' | 'edit' | 'append'>('view')
  const [expanded, setExpanded] = useState(false)
  const [showVector, setShowVector] = useState(false)
  const [saving, setSaving] = useState(false)
  const [content, setContent] = useState(chunk.content)
  const [labels, setLabels] = useState(chunk.labels.join(', '))
  const [rows, setRows] = useState<MetadataRow[]>([])
  const [newContent, setNewContent] = useState('')

  function startEditing() {
    setContent(chunk.content)
    setLabels(chunk.labels.join(', '))
    setRows(Object.entries(chunk.metadata).map(([key, value]) => ({ key, value: String(value) })))
    setMode('edit')
  }

  const fail = (error: unknown) => toast({ variant: 'destructive', description: errorMessage(error) })

  async function save(event: FormEvent) {
    event.preventDefault()
    const parsedLabels = parseLabels(labels)
    const parsedMetadata = buildMetadata(rows, chunk.metadata)
    const problem = parsedLabels.error ?? parsedMetadata.error
    if (problem) return fail(new Error(problem))
    const changes: { content?: string; labels?: string[]; metadata?: Record<string, ChunkMetadataValue> } = {}
    if (content.trim() !== chunk.content) changes.content = content.trim()
    if (parsedLabels.labels.join('\n') !== chunk.labels.join('\n')) changes.labels = parsedLabels.labels
    if (JSON.stringify(parsedMetadata.metadata) !== JSON.stringify(chunk.metadata)) changes.metadata = parsedMetadata.metadata
    if (Object.keys(changes).length === 0) return setMode('view')
    setSaving(true)
    try {
      await apiJson(`/api/corpus/chunks/${chunk.id}`, { method: 'PATCH', json: changes })
      toast({ description: changes.content !== undefined ? 'Chunk updated and re-embedded.' : 'Chunk updated.' })
      setMode('view')
      await onChanged()
    } catch (error) {
      fail(error)
    } finally {
      setSaving(false)
    }
  }

  async function append(event: FormEvent) {
    event.preventDefault()
    if (!newContent.trim()) return
    setSaving(true)
    try {
      await apiJson(`/api/corpus/documents/${chunk.documentId}/chunks`, { method: 'POST', json: { content: newContent.trim() } })
      toast({ description: `Chunk added to “${chunk.documentTitle}”.` })
      setNewContent('')
      setMode('view')
      await onChanged()
    } catch (error) {
      fail(error)
    } finally {
      setSaving(false)
    }
  }

  async function remove(kind: 'chunk' | 'document') {
    const confirmText = kind === 'chunk' ? 'Delete this chunk (text and vector) from the index?' : `Delete “${chunk.documentTitle}” and all of its chunks?`
    if (!window.confirm(confirmText)) return
    try {
      await apiJson(kind === 'chunk' ? `/api/corpus/chunks/${chunk.id}` : `/api/corpus/documents/${chunk.documentId}`, { method: 'DELETE' })
      toast({ description: kind === 'chunk' ? 'Chunk removed.' : 'Document removed.' })
      await onChanged()
    } catch (error) {
      fail(error)
    }
  }

  const contentChanged = mode === 'edit' && content.trim() !== chunk.content

  return (
    <article className="group rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm hover:border-primary/40">
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span className="flex items-center gap-1 rounded-md bg-secondary/70 px-2 py-0.5">
            <FileText className="size-3 text-primary" />
            <span className="max-w-[240px] truncate" title={chunk.source}>
              {chunk.documentTitle}
            </span>
          </span>
          <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">{notebookName}</span>
          <span className="text-[10px] text-muted-foreground">
            #{chunk.chunkIndex + 1} · {chunk.content.length} chars
            {chunk.updatedAt && ` · edited ${new Date(chunk.updatedAt).toLocaleDateString()}`}
          </span>
        </div>
        <div className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100">
          <button
            type="button"
            aria-label="Show vector"
            title="Show the stored embedding"
            onClick={() => setShowVector(!showVector)}
            className={cn('rounded p-1 hover:bg-secondary hover:text-foreground', showVector ? 'text-primary' : 'text-muted-foreground')}
          >
            <Binary className="size-3.5" />
          </button>
          {canEdit && mode === 'view' && (
            <>
              <button
                type="button"
                aria-label="Edit chunk"
                title="Edit text, labels and metadata"
                onClick={startEditing}
                className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Add a chunk to this document"
                title="Add a hand-written chunk to this document"
                onClick={() => setMode('append')}
                className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Delete chunk"
                title="Delete this chunk"
                onClick={() => void remove('chunk')}
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void remove('document')}
                className="rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                Delete document
              </button>
            </>
          )}
        </div>
      </header>

      {mode === 'edit' ? (
        <form onSubmit={save} className="space-y-3">
          <div>
            <Textarea
              aria-label="Chunk text"
              rows={8}
              value={content}
              maxLength={LIMITS.chunkChars}
              onChange={(event) => setContent(event.target.value)}
              className="font-mono text-xs leading-relaxed"
            />
            <p className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
              <span className={cn(contentChanged && 'text-amber-500')}>{contentChanged ? 'Saving will re-embed this text (one embedding call).' : 'Text unchanged.'}</span>
              <span>
                {content.length.toLocaleString()} / {LIMITS.chunkChars.toLocaleString()}
              </span>
            </p>
          </div>
          <label className="block space-y-1">
            <span className="flex items-center gap-1 text-xs font-medium">
              <Tag className="size-3" /> Labels
            </span>
            <Input value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="e.g. pricing, q3-2025, reviewed" className="h-8 text-xs" />
          </label>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Metadata</p>
            {rows.map((row, index) => (
              <div key={index} className="flex gap-1.5">
                <Input
                  aria-label="Metadata key"
                  value={row.key}
                  placeholder="key"
                  onChange={(event) => setRows(rows.map((r, i) => (i === index ? { ...r, key: event.target.value } : r)))}
                  className="h-8 w-36 font-mono text-xs"
                />
                <Input
                  aria-label="Metadata value"
                  value={row.value}
                  placeholder="value"
                  onChange={(event) => setRows(rows.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)))}
                  className="h-8 flex-1 text-xs"
                />
                <button
                  type="button"
                  aria-label="Remove field"
                  onClick={() => setRows(rows.filter((_, i) => i !== index))}
                  className="rounded px-1.5 text-muted-foreground hover:text-destructive"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setRows([...rows, { key: '', value: '' }])} className="font-mono text-[10px] text-primary hover:underline">
              + Add field
            </button>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode('view')}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving || !content.trim()}>
              {saving ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Save className="mr-2 size-3.5" />}
              Save
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className={expanded ? 'whitespace-pre-wrap text-xs leading-relaxed text-foreground/80' : 'line-clamp-3 text-xs leading-relaxed text-foreground/80'}>{chunk.content}</p>
          <button type="button" onClick={() => setExpanded(!expanded)} className="mt-1 font-mono text-[10px] text-primary hover:underline">
            {expanded ? 'Show less' : 'Show full chunk'}
          </button>
          {(chunk.labels.length > 0 || Object.keys(chunk.metadata).length > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {chunk.labels.map((label) => (
                <button
                  key={label}
                  type="button"
                  title="Show chunks with this label"
                  onClick={() => onFilterLabel(label)}
                  className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/20"
                >
                  <Tag className="size-2.5" />
                  {label}
                </button>
              ))}
              {Object.entries(chunk.metadata).map(([key, value]) => (
                <span key={key} className="rounded-md border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {key}: <span className="text-foreground/80">{String(value)}</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {mode === 'append' && (
        <form onSubmit={append} className="mt-3 space-y-2 rounded-lg border border-dashed border-primary/40 p-3">
          <p className="text-xs font-medium">New chunk at the end of “{chunk.documentTitle}”</p>
          <Textarea
            aria-label="New chunk text"
            rows={4}
            value={newContent}
            maxLength={LIMITS.chunkChars}
            onChange={(event) => setNewContent(event.target.value)}
            placeholder="Write a correction, a missing fact or a summary…"
            className="text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode('view')}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving || !newContent.trim()}>
              {saving ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
              Add chunk
            </Button>
          </div>
        </form>
      )}

      {showVector && (
        <div className="mt-3">
          <VectorSummary chunkId={chunk.id} />
        </div>
      )}
    </article>
  )
}

interface ChunkExplorerProps {
  collections: Collection[]
  selected: string
  onChanged: () => void
}

/** Browse, filter and edit the indexed chunks (text + vector live in one Postgres row). */
export function ChunkExplorer({ collections, selected, onChanged }: ChunkExplorerProps) {
  const [collectionId, setCollectionId] = useState(selected)
  const [search, setSearch] = useState('')
  const [label, setLabel] = useState('')
  const [page, setPage] = useState(0)
  const query = useDebouncedValue(search.trim(), 300)
  const labelFilter = useDebouncedValue(label.trim().toLowerCase(), 300)

  useEffect(() => setCollectionId(selected), [selected])
  useEffect(() => setPage(0), [collectionId, query, labelFilter])

  const chunks = useChunks({ collectionId: collectionId === 'all' ? null : collectionId, label: labelFilter, q: query, page, pageSize: PAGE_SIZE })
  const total = chunks.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const byId = new Map(collections.map((collection) => [collection.id, collection]))

  async function changed() {
    await chunks.mutate()
    onChanged()
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/50 pb-4">
        <label className="composer flex min-w-[220px] flex-1 items-center gap-2 px-3 py-1.5">
          <Search className="size-4 text-muted-foreground" />
          <span className="sr-only">Search chunks</span>
          <input
            type="search"
            value={search}
            maxLength={LIMITS.explorerSearchChars}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search passage text or document title…"
            className="w-full bg-transparent text-xs focus:outline-none"
          />
        </label>
        <label className="composer flex w-44 items-center gap-2 px-3 py-1.5">
          <Tag className="size-3.5 text-muted-foreground" />
          <span className="sr-only">Filter by label</span>
          <input
            type="search"
            value={label}
            maxLength={LIMITS.labelChars}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Label…"
            className="w-full bg-transparent text-xs focus:outline-none"
          />
        </label>
        <div className="w-48">
          <Select aria-label="Notebook" value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
            <option value="all">All notebooks</option>
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name} ({collection.chunkCount})
              </option>
            ))}
          </Select>
        </div>
        <button
          type="button"
          aria-label="Refresh"
          onClick={() => chunks.mutate()}
          className="flex size-9 items-center justify-center rounded-lg border border-border/70 bg-secondary/40 text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={chunks.isValidating ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto pr-1">
        {chunks.isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : chunks.error ? (
          <p className="py-10 text-center text-sm text-destructive">{errorMessage(chunks.error)}</p>
        ) : chunks.data?.items.length ? (
          chunks.data.items.map((chunk) => (
            <ChunkCard
              key={`${chunk.id}:${chunk.updatedAt ?? ''}`}
              chunk={chunk}
              notebookName={byId.get(chunk.collectionId)?.name ?? 'Notebook'}
              canEdit={atLeast(byId.get(chunk.collectionId)?.myRole, 'editor')}
              onFilterLabel={setLabel}
              onChanged={changed}
            />
          ))
        ) : (
          <div className="flex h-64 flex-col items-center justify-center text-center text-muted-foreground">
            <Database className="mb-2 size-8 opacity-40" />
            <p className="text-sm">{query || labelFilter ? 'No chunks match these filters.' : 'No chunks indexed yet.'}</p>
          </div>
        )}
      </div>

      {total > PAGE_SIZE && (
        <footer className="flex items-center justify-between border-t border-border/50 pt-3">
          <span className="font-mono text-xs text-muted-foreground">
            Page {page + 1} of {pages} · {total.toLocaleString()} chunks
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Previous page"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(p - 1, 0))}
              className="flex size-7 items-center justify-center rounded-lg border border-border/60 bg-secondary/40 disabled:opacity-40"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Next page"
              disabled={page >= pages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="flex size-7 items-center justify-center rounded-lg border border-border/60 bg-secondary/40 disabled:opacity-40"
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        </footer>
      )}
    </div>
  )
}
