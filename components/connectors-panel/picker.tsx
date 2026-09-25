'use client'

import { ArrowLeft, Check, ChevronRight, Database, FileText, Folder, Github, Globe, Loader2, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/feedback-primitives'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { apiJson, errorMessage } from '@/lib/api-client'
import type { ConnectionSummary, ConnectorBrowseItem, ConnectorBrowseResult } from '@/lib/contracts'
import { formatBytes, plural, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

import { PROVIDERS, SyncSettings } from './providers'

const ITEM_ICON: Record<ConnectorBrowseItem['kind'], typeof FileText> = { file: FileText, folder: Folder, page: FileText, database: Database, repository: Github, site: Globe }

/** Browse a connected account and pick what to keep in the notebook. */
export function Picker({
  connection,
  collectionId,
  onClose,
  onAdded,
}: {
  connection: ConnectionSummary | null
  collectionId: string | null
  onClose: () => void
  onAdded: () => void
}) {
  const { toast } = useToast()
  const [trail, setTrail] = useState<Array<{ id: string | null; name: string }>>([{ id: null, name: 'Home' }])
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<ConnectorBrowseItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Map<string, ConnectorBrowseItem>>(new Map())
  const [autoSync, setAutoSync] = useState(true)
  const [interval, setInterval] = useState(24)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const parent = trail[trail.length - 1]!.id

  const load = useCallback(
    async (more: string | null) => {
      if (!connection) return
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (parent) params.set('parent', parent)
        if (search) params.set('q', search)
        if (more) params.set('cursor', more)
        const result = await apiJson<ConnectorBrowseResult>(`/api/connectors/connections/${connection.id}/browse?${params.toString()}`)
        setItems((current) => (more ? [...current, ...result.items] : result.items))
        setCursor(result.nextCursor)
      } catch (loadError) {
        setError(errorMessage(loadError))
        if (!more) setItems([])
      } finally {
        setLoading(false)
      }
    },
    [connection, parent, search],
  )

  useEffect(() => {
    if (!connection) return
    setChosen(new Map())
  }, [connection])

  useEffect(() => {
    void load(null)
  }, [load])

  function toggle(item: ConnectorBrowseItem) {
    setChosen((current) => {
      const next = new Map(current)
      if (next.has(item.id)) next.delete(item.id)
      else if (next.size < 50) next.set(item.id, item)
      return next
    })
  }

  async function add() {
    if (!connection || !collectionId || chosen.size === 0) return
    setBusy(true)
    try {
      await apiJson('/api/connectors/sources', {
        method: 'POST',
        json: {
          collectionId,
          provider: connection.provider,
          connectionId: connection.id,
          items: [...chosen.values()].map((item) => ({ externalId: item.id, kind: item.kind, name: item.name.slice(0, 200) })),
          autoSync,
          syncIntervalHours: interval,
          options: path.trim() ? { path: path.trim() } : {},
        },
      })
      toast({ title: `Added ${plural(chosen.size, 'item')}`, description: 'The first sync has started — documents appear as they are indexed.' })
      onAdded()
    } catch (addError) {
      toast({ variant: 'destructive', description: errorMessage(addError) })
    } finally {
      setBusy(false)
    }
  }

  const isGitHub = connection?.provider === 'github'

  return (
    <Dialog
      open={connection !== null}
      onClose={onClose}
      title={connection ? `Add from ${PROVIDERS[connection.provider].label}` : ''}
      description={connection?.accountLabel}
      size="lg"
    >
      {connection && (
        <div className="flex flex-col gap-3 p-5">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              setSearch(query.trim())
            }}
            className="composer flex items-center gap-2 px-3 py-1.5"
          >
            <Search className="size-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={isGitHub ? 'owner/repository (e.g. vercel/next.js)' : connection.provider === 'notion' ? 'Search pages and databases' : 'Search by name'}
              className="w-full bg-transparent text-xs focus:outline-none"
              aria-label="Search"
            />
            <Button type="submit" size="sm" variant="ghost" className="h-7 px-2 text-xs">
              {isGitHub ? 'Find' : 'Search'}
            </Button>
          </form>

          {!search && trail.length > 1 && (
            <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <button type="button" onClick={() => setTrail((current) => current.slice(0, -1))} className="rounded p-0.5 hover:text-foreground" aria-label="Back">
                <ArrowLeft className="size-3.5" />
              </button>
              {trail.map((step, index) => (
                <span key={`${step.id}-${index}`} className="flex items-center gap-1">
                  {index > 0 && <ChevronRight className="size-3" />}
                  <button type="button" onClick={() => setTrail((current) => current.slice(0, index + 1))} className="hover:text-foreground">
                    {step.name}
                  </button>
                </span>
              ))}
            </nav>
          )}
          {search && (
            <button type="button" onClick={() => (setSearch(''), setQuery(''))} className="self-start text-[11px] text-primary hover:underline">
              Clear search “{search}”
            </button>
          )}

          <div className="max-h-[40vh] min-h-[160px] overflow-y-auto rounded-xl border border-border/60">
            {error ? (
              <p className="p-4 text-xs text-destructive">{error}</p>
            ) : loading && items.length === 0 ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2, 3].map((key) => (
                  <Skeleton key={key} className="h-9 rounded-lg" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <p className="p-6 text-center text-xs text-muted-foreground">
                {isGitHub && !search ? 'Type a repository name above, e.g. owner/name.' : 'Nothing here. Check that the item is shared with this account.'}
              </p>
            ) : (
              <ul className="divide-y divide-border/50">
                {items.map((item) => {
                  const Icon = ITEM_ICON[item.kind]
                  const on = chosen.has(item.id)
                  return (
                    <li key={item.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                      <input type="checkbox" aria-label={`Select ${item.name}`} checked={on} disabled={!item.importable} onChange={() => toggle(item)} />
                      <Icon className={cn('size-4 shrink-0', item.kind === 'folder' ? 'text-amber-500' : 'text-muted-foreground')} />
                      <button
                        type="button"
                        disabled={!item.container}
                        onClick={() => item.container && setTrail((current) => [...current, { id: item.id, name: item.name }])}
                        className={cn(
                          'min-w-0 flex-1 truncate text-left',
                          item.container ? 'font-medium hover:text-primary' : 'cursor-default',
                          !item.importable && 'text-muted-foreground',
                        )}
                        title={item.name}
                      >
                        {item.name}
                      </button>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {[item.size ? formatBytes(item.size) : null, item.modifiedAt ? timeAgo(item.modifiedAt) : null].filter(Boolean).join(' · ')}
                      </span>
                      {item.container && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                    </li>
                  )
                })}
              </ul>
            )}
            {cursor && (
              <button type="button" onClick={() => void load(cursor)} disabled={loading} className="w-full py-2 text-[11px] text-primary hover:bg-primary/5">
                {loading ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>

          {isGitHub && (
            <div className="space-y-1">
              <Label htmlFor="repo-path">Only this folder (optional)</Label>
              <Input id="repo-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="docs/" className="h-8 text-xs" />
            </div>
          )}
          <SyncSettings autoSync={autoSync} interval={interval} onAutoSync={setAutoSync} onInterval={setInterval} />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">{chosen.size ? `${plural(chosen.size, 'item')} selected` : 'Select files, folders, pages or repositories'}</p>
            <Button type="button" size="sm" variant="brand" disabled={busy || chosen.size === 0 || !collectionId} onClick={() => void add()}>
              {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Check className="mr-2 size-3.5" />}
              Add to notebook
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
