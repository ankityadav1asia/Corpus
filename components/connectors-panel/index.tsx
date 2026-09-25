'use client'

import { AlertTriangle, Check, Globe, Plug, RefreshCw, Unplug } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { EmptyState, Skeleton } from '@/components/ui/feedback-primitives'
import { useToast } from '@/components/ui/use-toast'
import { useWorkspaceContext } from '@/components/workspace-provider'
import { useConnectors } from '@/hooks/use-api'
import { apiJson, errorMessage } from '@/lib/api-client'
import type { ConnectionSummary, ConnectorProvider } from '@/lib/contracts'
import { cn } from '@/lib/utils'

import { TokenDialog, WebsiteDialog } from './connect-dialogs'
import { Picker } from './picker'
import { PROVIDERS, ProviderIcon } from './providers'
import { SourceRow } from './source-row'

interface ConnectorsPanelProps {
  collectionId: string | null
  canEdit: boolean
  onChanged: () => void
}

/** "Apps" tab of the Sources drawer: connected accounts, adding from them, and synced sources. */
export function ConnectorsPanel({ collectionId, canEdit, onChanged }: ConnectorsPanelProps) {
  const { toast } = useToast()
  const workspace = useWorkspaceContext()
  const overview = useConnectors()
  const [tokenFor, setTokenFor] = useState<'notion' | 'github' | null>(null)
  const [websiteOpen, setWebsiteOpen] = useState(false)
  const [pickerFor, setPickerFor] = useState<ConnectionSummary | null>(null)
  const data = overview.data
  const mine = (provider: ConnectorProvider) => (data?.connections ?? []).filter((connection) => connection.provider === provider && connection.mine)
  const sources = (data?.sources ?? []).filter((source) => source.collectionId === collectionId)

  function refresh() {
    void overview.mutate()
    onChanged()
  }

  function connect(provider: ConnectorProvider) {
    if (provider === 'website') return setWebsiteOpen(true)
    if (provider === 'google_drive') {
      if (!workspace.active) return
      // A top-level navigation: Google shows its consent screen, then returns to the app.
      window.location.href = `/api/connectors/google-drive/start?w=${encodeURIComponent(workspace.active.id)}`
      return
    }
    setTokenFor(provider)
  }

  async function disconnect(connection: ConnectionSummary) {
    if (!window.confirm(`Disconnect ${connection.accountLabel}? Its synced sources stop; documents already imported stay.`)) return
    try {
      await apiJson(`/api/connectors/connections/${connection.id}`, { method: 'DELETE' })
      toast({ description: 'Disconnected.' })
      refresh()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    }
  }

  if (!canEdit) {
    return <p className="text-xs text-muted-foreground">You need Editor access to this notebook to connect apps and import from them.</p>
  }

  return (
    <div className="space-y-4">
      {overview.isLoading ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(PROVIDERS) as ConnectorProvider[]).map((provider) => {
            const info = PROVIDERS[provider]
            const availability = data?.providers.find((item) => item.id === provider)
            const connections = mine(provider)
            return (
              <div key={provider} className={cn('flex flex-col gap-2 rounded-xl border border-border/60 bg-card/60 p-3', !availability?.available && 'opacity-60')}>
                <div className="flex items-start gap-2.5">
                  <ProviderIcon provider={provider} />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">{info.label}</p>
                    <p className="text-[10px] leading-snug text-muted-foreground">{availability?.available ? info.description : availability?.reason}</p>
                  </div>
                </div>
                {connections.map((connection) => (
                  <div key={connection.id} className="flex items-center gap-1.5 rounded-lg bg-secondary/50 px-2 py-1">
                    {connection.status === 'error' ? <AlertTriangle className="size-3 shrink-0 text-destructive" /> : <Check className="size-3 shrink-0 text-success" />}
                    <span className="min-w-0 flex-1 truncate text-[11px]" title={connection.error ?? connection.accountLabel}>
                      {connection.accountLabel}
                    </span>
                    <button type="button" onClick={() => setPickerFor(connection)} className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/10">
                      Add
                    </button>
                    <button
                      type="button"
                      aria-label={`Disconnect ${connection.accountLabel}`}
                      onClick={() => void disconnect(connection)}
                      className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                    >
                      <Unplug className="size-3" />
                    </button>
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-auto h-7 text-[11px]"
                  disabled={!availability?.available || !collectionId}
                  onClick={() => connect(provider)}
                >
                  {provider === 'website' ? (
                    <>
                      <Globe className="mr-1.5 size-3" /> Add a website
                    </>
                  ) : connections.length ? (
                    <>
                      <Plug className="mr-1.5 size-3" /> Connect another account
                    </>
                  ) : (
                    <>
                      <Plug className="mr-1.5 size-3" /> Connect
                    </>
                  )}
                </Button>
              </div>
            )
          })}
        </div>
      )}

      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Synced into this notebook</p>
        {sources.length === 0 ? (
          <EmptyState
            icon={RefreshCw}
            title="Nothing synced yet"
            description="Connect an app and add files, pages, repositories or a website — they stay up to date automatically."
            className="py-6"
          />
        ) : (
          <ul className="space-y-2">
            {sources.map((source) => (
              <SourceRow key={source.id} source={source} onChanged={refresh} />
            ))}
          </ul>
        )}
      </div>

      <TokenDialog
        provider={tokenFor}
        onClose={() => setTokenFor(null)}
        onConnected={(connection) => {
          setTokenFor(null)
          void overview.mutate()
          setPickerFor(connection)
        }}
      />
      <WebsiteDialog
        open={websiteOpen}
        collectionId={collectionId}
        onClose={() => setWebsiteOpen(false)}
        onAdded={() => {
          setWebsiteOpen(false)
          refresh()
        }}
      />
      <Picker
        connection={pickerFor}
        collectionId={collectionId}
        onClose={() => setPickerFor(null)}
        onAdded={() => {
          setPickerFor(null)
          refresh()
        }}
      />
    </div>
  )
}
