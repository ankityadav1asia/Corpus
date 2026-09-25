'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

interface PopoverProps {
  /** Accessible name of the trigger button. */
  label: string
  trigger: ReactNode
  triggerClassName?: string
  align?: 'start' | 'end'
  width?: number
  className?: string
  children: ReactNode | ((close: () => void) => ReactNode)
}

const MARGIN = 8

/**
 * Button + floating panel rendered in a portal (never clipped by scrolling containers). Closes on
 * outside click, Escape, scroll or resize. Children may be a function receiving `close`.
 */
export function Popover({ label, trigger, triggerClassName, align = 'end', width = 260, className, children }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])

  // Place below the trigger, or above it when there is no room; keep inside the viewport.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const height = panelRef.current?.offsetHeight ?? 0
    let top = rect.bottom + 6
    if (top + height > window.innerHeight - MARGIN && rect.top - 6 - height > MARGIN) top = rect.top - 6 - height
    const preferred = align === 'end' ? rect.right - width : rect.left
    const left = Math.min(Math.max(MARGIN, preferred), window.innerWidth - width - MARGIN)
    setPosition({ top, left })
  }, [open, align, width])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onViewport = (event: Event) => {
      if (event.type === 'scroll' && panelRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onViewport)
    window.addEventListener('scroll', onViewport, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onViewport)
      window.removeEventListener('scroll', onViewport, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setPosition(null)
          setOpen((value) => !value)
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            style={{ top: position?.top ?? -9999, left: position?.left ?? -9999, width }}
            className={cn('surface-float fixed z-[70] animate-slide-down overflow-hidden p-1', className)}
          >
            {typeof children === 'function' ? children(close) : children}
          </div>,
          document.body,
        )}
    </>
  )
}

interface MenuItemProps {
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  hint?: ReactNode
  children: ReactNode
}

export function MenuItem({ icon, onSelect, danger, disabled, hint, children }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-40',
        danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-secondary',
      )}
    >
      {icon && <span className={cn('shrink-0', danger ? 'text-destructive' : 'text-muted-foreground')}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[10px] text-muted-foreground">{hint}</span>}
    </button>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border/70" />
}
