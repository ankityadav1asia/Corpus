import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** A still block in the shape of what is loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton h-4 w-full', className)} />
}

/** Determinate bar (value 0–1) or an indeterminate sweep when value is null. */
export function Progress({ value, className, label }: { value: number | null; className?: string; label?: string }) {
  const percent = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={cn('relative h-1 w-full overflow-hidden rounded-sm bg-paper-3', className)}
    >
      {percent === null ? (
        <div className="absolute inset-y-0 w-2/5 animate-indeterminate bg-cool" />
      ) : (
        <div className="h-full origin-left bg-cool transition-transform duration-long ease-out" style={{ transform: `scaleX(${percent / 100})` }} />
      )}
    </div>
  )
}

/** A keyboard key, e.g. <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-rule-2 bg-paper-3 px-1 text-[11px] font-medium text-muted-foreground', className)}
    >
      {children}
    </kbd>
  )
}

/** Initials in a hairline square. */
export function Avatar({ name, email, className }: { name: string | null; email: string; className?: string }) {
  const source = (name ?? email).trim()
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  const initials = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[1]?.[0] ?? '') : '')).toUpperCase()
  return (
    <span
      aria-hidden
      className={cn('flex size-8 shrink-0 select-none items-center justify-center rounded-md border border-rule-2 bg-paper-3 text-[11px] font-medium text-ink-2', className)}
    >
      {initials}
    </span>
  )
}

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}

/** What is empty, why it matters and the one action that fills it; left-aligned like the list it stands in for. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-start px-4 py-8', className)}>
      <Icon aria-hidden className="mb-3 size-5 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <div className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted-foreground">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
