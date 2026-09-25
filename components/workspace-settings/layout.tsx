'use client'

import type { ReactNode } from 'react'

import { Input } from '@/components/ui/input'

export function Section({ title, icon, children, description }: { title: string; icon: ReactNode; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-b border-border/40 px-5 py-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {title}
        </h3>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs font-medium">{label}</p>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

export function NumberField(props: { label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onChange: (value: number) => void }) {
  return (
    <Input
      type="number"
      aria-label={props.label}
      className="h-8 w-20 text-right font-mono text-xs"
      value={Number.isFinite(props.value) ? props.value : ''}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.valueAsNumber)}
    />
  )
}

export function GroupHeading({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return <p className={`${first ? '' : 'pt-2 '}font-mono text-[10px] uppercase tracking-wider text-muted-foreground`}>{children}</p>
}
