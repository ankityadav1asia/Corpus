'use client'

import { AlertTriangle, Loader2, Network, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'

import { MindMapViewer } from '@/components/mindmap-viewer'
import { SourcePicker, hasSelection, type SourceSelection } from '@/components/studio/source-picker'
import { Button } from '@/components/ui/button'
import { EmptyState, Skeleton } from '@/components/ui/feedback-primitives'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { useWorkspaceContext } from '@/components/workspace-provider'
import { useMindMap, useMindMaps } from '@/hooks/use-api'
import { apiJson, errorMessage } from '@/lib/api-client'
import { STUDIO_LIMITS } from '@/lib/constants'
import type { Collection, MindMapSummary, SessionUser } from '@/lib/contracts'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { canManageOwned } from '@/lib/roles'

interface MindMapStudioProps {
  collections: Collection[]
  user: SessionUser
  enabled: boolean
  focusId: string | null
  onFocusConsumed: () => void
  onAsk: (question: string) => void
  onOpenSource: (documentId: string) => void
}

export function MindMapStudio({ collections, user, enabled, focusId, onFocusConsumed, onAsk, onOpenSource }: MindMapStudioProps) {
  const { toast } = useToast()
  const { role } = useWorkspaceContext()
  const list = useMindMaps()
  const maps = useMemo(() => list.data?.mindMaps ?? [], [list.data])
  const [openId, setOpenId] = useState<string | null>(null)
  const detail = useMindMap(openId)
  const [selection, setSelection] = useState<SourceSelection>({ collectionIds: collections[0] ? [collections[0].id] : [], documentIds: [] })
  const [focus, setFocus] = useState('')
  const [busy, setBusy] = useState(false)

  // Default to the first notebook once the notebooks have loaded (only once: the member may clear it).
  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current || !collections[0]) return
    initialized.current = true
    setSelection((current) => (hasSelection(current) ? current : { collectionIds: [collections[0]!.id], documentIds: [] }))
  }, [collections])

  useEffect(() => {
    if (!focusId) return
    setOpenId(focusId)
    onFocusConsumed()
  }, [focusId, onFocusConsumed])

  useEffect(() => {
    if (!openId && maps[0]) setOpenId(maps[0].id)
  }, [openId, maps])

  async function create(input: SourceSelection & { focus?: string }) {
    setBusy(true)
    try {
      const { mindMap } = await apiJson<{ mindMap: MindMapSummary }>('/api/mindmaps', { method: 'POST', json: input })
      setOpenId(mindMap.id)
      await list.mutate()
      toast({ description: 'Building the mind map — usually under a minute.' })
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    await create({ ...selection, focus: focus.trim() || undefined })
  }

  async function remove(id: string, title: string) {
    if (!window.confirm(`Delete “${title}”?`)) return
    try {
      await apiJson(`/api/mindmaps/${id}`, { method: 'DELETE' })
      setOpenId(null)
      await list.mutate()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    }
  }

  const open = detail.data?.mindMap

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pr-1">
      <form onSubmit={submit} className="relative shrink-0 overflow-hidden rounded-2xl border border-primary/25 bg-brand-soft p-5">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-xl bg-brand-gradient shadow-md">
            <Network className="size-4 text-white" />
          </div>
          <div>
            <h3 className="font-display text-sm font-semibold">Build a mind map</h3>
            <p className="text-[11px] text-muted-foreground">See how the topics in your sources connect — then click any topic to ask about it.</p>
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <SourcePicker collections={collections} value={selection} onChange={setSelection} disabled={!enabled} />
          <div className="flex flex-col justify-between gap-3">
            <div>
              <label htmlFor="mindmap-focus" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Focus (optional)
              </label>
              <Input
                id="mindmap-focus"
                value={focus}
                maxLength={STUDIO_LIMITS.focusChars}
                disabled={!enabled}
                onChange={(event) => setFocus(event.target.value)}
                placeholder="e.g. costs and risks"
                className="bg-card/80 text-xs"
              />
            </div>
            <Button type="submit" variant="brand" disabled={!enabled || busy || !hasSelection(selection)} className="self-end">
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Sparkles className="mr-2 size-4" />}
              Build mind map
            </Button>
          </div>
        </div>
      </form>

      <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
        {list.isLoading
          ? [0, 1, 2].map((key) => <Skeleton key={key} className="h-14 w-56 shrink-0 rounded-2xl" />)
          : maps.map((map) => {
              const running = map.status === 'queued' || map.status === 'running'
              return (
                <button
                  key={map.id}
                  type="button"
                  onClick={() => setOpenId(map.id)}
                  className={cn(
                    'flex w-60 shrink-0 animate-fade-up items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-all',
                    map.id === openId ? 'border-primary/60 bg-primary/5 shadow-sm' : 'border-border/60 bg-card/60 hover:border-primary/30',
                  )}
                >
                  {map.status === 'failed' ? (
                    <AlertTriangle className="size-4 shrink-0 text-destructive" />
                  ) : running ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Network className="size-4 shrink-0 text-primary" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{map.title}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {running ? (map.progress ?? 'Queued') : map.status === 'failed' ? 'Could not be built' : `${map.nodeCount ?? 0} topics · ${timeAgo(map.createdAt)}`}
                    </span>
                  </span>
                </button>
              )
            })}
      </div>

      <section className="min-h-[520px] shrink-0">
        {!openId ? (
          <EmptyState icon={Network} title="No mind maps yet" description="Pick notebooks or documents above and build your first map." />
        ) : !open ? (
          <Skeleton className="h-[480px] rounded-2xl" />
        ) : open.status === 'completed' && open.root ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate font-display text-lg font-semibold">{open.title}</h3>
                <p className="text-[11px] text-muted-foreground">
                  {open.nodeCount} topics from {open.sources.length} source{open.sources.length === 1 ? '' : 's'}
                  {open.focus ? ` · focus: ${open.focus}` : ''}
                </p>
              </div>
              {canManageOwned(role, open.createdByEmail, user.email) && (
                <Button type="button" size="sm" variant="ghost" aria-label="Delete mind map" onClick={() => void remove(open.id, open.title)}>
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
            <MindMapViewer key={open.id} map={{ ...open, root: open.root }} onAsk={onAsk} onOpenSource={onOpenSource} />
          </div>
        ) : open.status === 'failed' ? (
          <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
            <AlertTriangle className="mb-2 size-5" />
            <p>{open.error ?? 'The mind map could not be built.'}</p>
            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void create({ collectionIds: open.collectionIds, documentIds: open.documentIds, focus: open.focus ?? undefined })}
              >
                <RotateCcw className="mr-1.5 size-3.5" /> Try again
              </Button>
              {canManageOwned(role, open.createdByEmail, user.email) && (
                <Button type="button" size="sm" variant="ghost" onClick={() => void remove(open.id, open.title)}>
                  Delete
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="generating flex h-[420px] flex-col items-center justify-center rounded-2xl border border-primary/30 text-center">
            <Network className="size-10 animate-pulse text-primary" />
            <p className="mt-4 text-sm font-semibold">{open.progress ?? 'Queued'}</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">Reading each source and arranging its topics into a map.</p>
          </div>
        )}
      </section>
    </div>
  )
}
