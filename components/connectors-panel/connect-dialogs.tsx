'use client'

import { ExternalLink, Globe, Loader2, Plug } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { apiJson, errorMessage } from '@/lib/api-client'
import type { ConnectionSummary } from '@/lib/contracts'

import { PROVIDERS, SyncSettings } from './providers'

/** Paste-a-token connection for Notion (integration secret) and GitHub (optional personal access token). */
export function TokenDialog({
  provider,
  onClose,
  onConnected,
}: {
  provider: 'notion' | 'github' | null
  onClose: () => void
  onConnected: (connection: ConnectionSummary) => void
}) {
  const { toast } = useToast()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setToken(''), [provider])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!provider) return
    setBusy(true)
    try {
      const { connection } = await apiJson<{ connection: ConnectionSummary }>('/api/connectors/connections', { method: 'POST', json: { provider, token: token.trim() } })
      toast({ title: `${PROVIDERS[provider].label} connected`, description: connection.accountLabel })
      onConnected(connection)
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={provider !== null} onClose={onClose} title={provider ? `Connect ${PROVIDERS[provider].label}` : ''} size="sm">
      {provider && (
        <form onSubmit={submit} className="space-y-4 p-5">
          {provider === 'notion' ? (
            <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
              <li>
                Create an internal integration at{' '}
                <a href="https://www.notion.so/profile/integrations" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  notion.so/profile/integrations <ExternalLink className="inline size-3" />
                </a>
                .
              </li>
              <li>In Notion, open each page or database → ••• → Connections → add your integration.</li>
              <li>Paste the integration secret below.</li>
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">
              Public repositories work without a token. For private repositories, create a fine-grained token with read-only <em>Contents</em> access.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="connector-token">{provider === 'notion' ? 'Integration secret' : 'Personal access token (optional)'}</Label>
            <Input
              id="connector-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={provider === 'notion' ? 'ntn_…' : 'github_pat_… (leave empty for public repositories)'}
              required={provider === 'notion'}
            />
            <p className="text-[10px] text-muted-foreground">Stored encrypted and used only for your own imports.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="brand" disabled={busy || (provider === 'notion' && !token.trim())}>
              {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plug className="mr-2 size-3.5" />}
              Connect
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

export function WebsiteDialog({ open, collectionId, onClose, onAdded }: { open: boolean; collectionId: string | null; onClose: () => void; onAdded: () => void }) {
  const { toast } = useToast()
  const [url, setUrl] = useState('')
  const [maxPages, setMaxPages] = useState(25)
  const [autoSync, setAutoSync] = useState(true)
  const [interval, setInterval] = useState(168)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!collectionId) return
    setBusy(true)
    try {
      const name = (() => {
        try {
          const parsed = new URL(url.trim())
          return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
        } catch {
          return url.trim()
        }
      })()
      await apiJson('/api/connectors/sources', {
        method: 'POST',
        json: {
          collectionId,
          provider: 'website',
          connectionId: null,
          items: [{ externalId: url.trim(), kind: 'site', name: name.slice(0, 200) }],
          autoSync,
          syncIntervalHours: interval,
          options: { maxPages },
        },
      })
      toast({ title: 'Website added', description: 'Its pages are being read in the background.' })
      setUrl('')
      onAdded()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add a website" description="Pages under this address are read and kept up to date." size="sm">
      <form onSubmit={submit} className="space-y-4 p-5">
        <div className="space-y-1.5">
          <Label htmlFor="site-url">Start page</Label>
          <Input id="site-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://docs.example.com/guide/" />
          <p className="text-[10px] text-muted-foreground">Only pages in the same folder are included; robots.txt is respected.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="site-pages">
            Pages to read: <span className="font-mono">{maxPages}</span>
          </Label>
          <input
            id="site-pages"
            type="range"
            min={5}
            max={100}
            step={5}
            value={maxPages}
            onChange={(event) => setMaxPages(Number(event.target.value))}
            className="w-full accent-[hsl(var(--primary))]"
          />
        </div>
        <SyncSettings autoSync={autoSync} interval={interval} onAutoSync={setAutoSync} onInterval={setInterval} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="brand" disabled={busy || !url.trim() || !collectionId}>
            {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Globe className="mr-2 size-3.5" />}
            Add website
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
