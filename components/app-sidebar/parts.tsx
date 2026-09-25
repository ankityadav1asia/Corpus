'use client'

import { Check, X, type LucideIcon } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function InlineNameForm({
  initial,
  label,
  maxLength,
  onSave,
  onCancel,
}: {
  initial: string
  label: string
  maxLength: number
  onSave: (name: string) => Promise<boolean>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    const ok = await onSave(name.trim())
    setSaving(false)
    if (ok) onCancel()
  }

  return (
    <form onSubmit={submit} className="flex animate-slide-down gap-1.5">
      <input
        autoFocus
        aria-label={label}
        value={name}
        maxLength={maxLength}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
        placeholder={label}
        className="h-8 min-w-0 flex-1 rounded-lg border border-primary/50 bg-background px-2.5 text-[13px] focus:outline-none focus:ring-4 focus:ring-primary/10"
      />
      <button
        type="submit"
        aria-label="Save"
        disabled={saving || !name.trim()}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
      >
        <Check className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </form>
  )
}

export function RailButton({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={label}
      className={cn(
        'relative flex w-full shrink-0 flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-[10px] font-medium leading-none transition-colors',
        active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-2 -left-1.5 w-1 rounded-full bg-brand-gradient" />}
      <Icon className={cn('size-[18px]', active && 'text-primary')} />
      <span className="max-w-full truncate">{label}</span>
    </button>
  )
}

export const RailDivider = () => <div aria-hidden className="mx-auto my-1 h-px w-8 shrink-0 bg-border/70" />

export function RailIconButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      <Icon className="size-4" />
    </button>
  )
}

export function HistoryHeading({ children }: { children: ReactNode }) {
  return <p className="sticky top-0 z-10 bg-card px-2.5 pb-1 pt-3 text-[11px] font-semibold text-muted-foreground">{children}</p>
}
