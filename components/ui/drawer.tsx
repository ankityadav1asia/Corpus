'use client'

import * as React from 'react'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

interface DrawerProps {
  open: boolean
  onClose: () => void
  title: string
  description?: React.ReactNode
  side?: 'left' | 'right'
  className?: string
  children: React.ReactNode
}

/** Slide-over panel with a blurred backdrop, Escape to close, and `inert` content while hidden. */
export function Drawer({ open, onClose, title, description, side = 'right', className, children }: DrawerProps) {
  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={cn('fixed inset-0 z-40 bg-background/60 backdrop-blur-sm transition-opacity duration-300', open ? 'opacity-100' : 'pointer-events-none opacity-0')}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        inert={!open}
        className={cn(
          'fixed inset-y-0 z-50 flex w-full max-w-md flex-col border-border/70 bg-card/95 backdrop-blur-2xl transition-transform duration-300 ease-smooth',
          side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
          open ? 'translate-x-0 shadow-2xl' : side === 'right' ? 'translate-x-full' : '-translate-x-full',
          className,
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-display text-base font-semibold tracking-tight">{title}</h2>
            {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>
        {children}
      </aside>
    </>
  )
}
