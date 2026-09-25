'use client'

import { X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', full: 'max-w-6xl' } as const

interface DialogProps {
  open: boolean
  onClose: () => void
  title?: string
  description?: ReactNode
  size?: keyof typeof SIZES
  /** Hide the built-in header (the content brings its own). */
  bare?: boolean
  className?: string
  children: ReactNode
}

/**
 * Modal dialog rendered in a portal: backdrop blur, scale-in animation, Escape / backdrop click to
 * close, focus moved inside on open and restored on close.
 */
export function Dialog({ open, onClose, title, description, size = 'md', bare, className, children }: DialogProps) {
  const [mounted, setMounted] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    // Focus the first field (or the panel) once it is on screen.
    const frame = requestAnimationFrame(() => {
      const target = panelRef.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button:not([data-dialog-close])') ?? panelRef.current
      target?.focus()
    })
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      cancelAnimationFrame(frame)
      document.body.style.overflow = ''
      previous?.focus?.()
    }
  }, [open, onClose])

  if (!mounted || !open) return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 pt-[8vh] sm:p-6 sm:pt-[10vh]">
      <div aria-hidden onClick={onClose} className="fixed inset-0 animate-fade-in bg-background/70 backdrop-blur-md" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn('surface-float relative w-full animate-scale-in outline-none', SIZES[size], className)}
      >
        {!bare && (title || description) && (
          <header className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
            <div className="min-w-0">
              {title && <h2 className="font-display text-base font-semibold tracking-tight">{title}</h2>}
              {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
            </div>
            <button
              type="button"
              data-dialog-close
              aria-label="Close"
              onClick={onClose}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </header>
        )}
        {children}
      </div>
    </div>,
    document.body,
  )
}
