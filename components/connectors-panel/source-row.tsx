'use client'

import { Loader2, MoreHorizontal, RefreshCw, Trash2, Unplug } from 'lucide-react'

import { MenuItem, MenuSeparator, Popover } from '@/components/ui/popover'
import { useToast } from '@/components/ui/use-toast'
import { apiJson, errorMessage } from '@/lib/api-client'
import type { ConnectorSourceSummary } from '@/lib/contracts'
import { plural, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

import { INTERVALS, ProviderIcon } from './providers'

export function SourceRow({ source, onChanged }: { source: ConnectorSourceSummary; onChanged: () => void }) {
  const { toast } = useToast()
  const busy = source.status === 'queued' || source.status === 'syncing'

  async function run(action: () => Promise<unknown>, success?: string) {
    try {
      await action()
      if (success) toast({ description: success })
      onChanged()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    }
  }

  const remove = (withDocuments: boolean) =>
    run(
      () => apiJson(`/api/connectors/sources/${source.id}${withDocuments ? '?documents=delete' : ''}`, { method: 'DELETE' }),
      withDocuments ? 'Stopped syncing and removed its documents.' : 'Stopped syncing; documents kept.',
    )

  return (
    <li className="rounded-xl border border-border/60 bg-card/60 p-3 text-xs">
      <div className="flex items-center gap-3">
        <ProviderIcon provider={source.provider} className="size-8" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={source.url ?? source.name}>
            {source.name}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {busy
              ? (source.progress ?? 'Waiting to sync')
              : source.status === 'error'
                ? 'Sync failed'
                : `${plural(source.itemCount, 'item')} · ${source.lastSyncedAt ? `synced ${timeAgo(source.lastSyncedAt)}` : 'not synced yet'}${source.autoSync ? ` · ${INTERVALS.find((option) => option.hours === source.syncIntervalHours)?.label.toLowerCase() ?? `every ${source.syncIntervalHours} h`}` : ' · manual'}`}
          </p>
        </div>
        {busy ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : (
          <button
            type="button"
            aria-label={`Sync ${source.name} now`}
            title="Sync now"
            onClick={() => void run(() => apiJson(`/api/connectors/sources/${source.id}/sync`, { method: 'POST' }), 'Sync started.')}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
        )}
        <Popover
          label={`Options for ${source.name}`}
          trigger={<MoreHorizontal className="size-3.5" />}
          triggerClassName="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          width={230}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<RefreshCw className="size-3.5" />}
                onSelect={() => {
                  close()
                  void run(() => apiJson(`/api/connectors/sources/${source.id}`, { method: 'PATCH', json: { autoSync: !source.autoSync } }))
                }}
              >
                {source.autoSync ? 'Turn off scheduled sync' : 'Turn on scheduled sync'}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Unplug className="size-3.5" />}
                onSelect={() => {
                  close()
                  void remove(false)
                }}
              >
                Stop syncing, keep documents
              </MenuItem>
              <MenuItem
                danger
                icon={<Trash2 className="size-3.5" />}
                onSelect={() => {
                  close()
                  if (window.confirm(`Stop syncing “${source.name}” and remove the documents it imported?`)) void remove(true)
                }}
              >
                Stop syncing and remove documents
              </MenuItem>
            </>
          )}
        </Popover>
      </div>
      {source.lastError && (
        <p className={cn('mt-2 rounded-lg px-2 py-1.5 text-[11px]', source.status === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-foreground/80')}>
          {source.lastError}
        </p>
      )}
    </li>
  )
}
