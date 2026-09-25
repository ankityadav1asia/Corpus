import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** Shimmering placeholder while content loads. */
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
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      {percent === null ? (
        <div className="absolute inset-y-0 w-2/5 animate-indeterminate rounded-full bg-brand-gradient" />
      ) : (
        <div className="h-full rounded-full bg-brand-gradient transition-[width] duration-500 ease-out" style={{ width: `${percent}%` }} />
      )}
    </div>
  )
}

/** A keyboard key, e.g. <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border/80 bg-muted/60 px-1 font-mono text-[10px] font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** Initials on a brand-gradient disc. */
export function Avatar({ name, email, className }: { name: string | null; email: string; className?: string }) {
  const source = (name ?? email).trim()
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  const initials = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[1]?.[0] ?? '') : '')).toUpperCase()
  return (
    <span
      aria-hidden
      className={cn('flex size-8 shrink-0 select-none items-center justify-center rounded-full bg-brand-gradient text-[11px] font-bold text-white shadow-sm', className)}
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

/** Friendly placeholder for empty lists, with a gently floating icon. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="relative mb-4">
        <div aria-hidden className="absolute inset-0 rounded-2xl bg-brand-gradient opacity-25 blur-xl" />
        <div className="relative flex size-14 animate-float items-center justify-center rounded-2xl border border-border/70 bg-card">
          <Icon className="size-6 text-primary" />
        </div>
      </div>
      <p className="font-display text-base font-semibold tracking-tight">{title}</p>
      {description && <div className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
