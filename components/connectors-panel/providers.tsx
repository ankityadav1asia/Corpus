'use client'

import { HardDrive } from 'lucide-react'

import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { CONNECTOR_LABELS } from '@/lib/constants'
import type { ConnectorProvider } from '@/lib/contracts'
import { cn } from '@/lib/utils'

export const PROVIDERS: Record<ConnectorProvider, { label: string; description: string; icon: typeof HardDrive }> = {
  google_drive: {
    label: CONNECTOR_LABELS.google_drive,
    description: 'Docs, Sheets, Slides, PDFs, images and recordings; whole folders stay in sync.',
    icon: HardDrive,
  },
}

export const INTERVALS = [
  { hours: 6, label: 'Every 6 hours' },
  { hours: 12, label: 'Every 12 hours' },
  { hours: 24, label: 'Daily' },
  { hours: 168, label: 'Weekly' },
]

export function ProviderIcon({ provider, className }: { provider: ConnectorProvider; className?: string }) {
  const { icon: Icon } = PROVIDERS[provider]
  return (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md border border-rule-2 bg-paper-3 text-ink-2', className)}>
      <Icon className="size-4" />
    </span>
  )
}

export function SyncSettings({
  autoSync,
  interval,
  onAutoSync,
  onInterval,
}: {
  autoSync: boolean
  interval: number
  onAutoSync: (value: boolean) => void
  onInterval: (value: number) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-card/50 px-3 py-2">
      <Switch label="Keep in sync" checked={autoSync} onChange={onAutoSync} />
      <span className="text-xs">Keep in sync</span>
      <div className="ml-auto w-36">
        <Select aria-label="Sync frequency" value={String(interval)} disabled={!autoSync} onChange={(event) => onInterval(Number(event.target.value))}>
          {INTERVALS.map((option) => (
            <option key={option.hours} value={option.hours}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  )
}
