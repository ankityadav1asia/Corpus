import * as React from 'react'

import { cn } from '@/lib/utils'

interface TooltipProps {
  label: string
  side?: 'top' | 'bottom'
  /** Use 'end' for triggers near a right edge so the bubble grows leftwards. */
  align?: 'center' | 'start' | 'end'
  children: React.ReactNode
}

/**
 * CSS-only tooltip for icon buttons (hover and keyboard focus). Pair with aria-label.
 * The bubble is display:none until shown, so it never widens scroll containers.
 */
export function Tooltip({ label, side = 'top', align = 'center', children }: TooltipProps) {
  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 hidden whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md group-focus-within/tooltip:block group-hover/tooltip:block',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          align === 'center' && 'left-1/2 -translate-x-1/2',
          align === 'start' && 'left-0',
          align === 'end' && 'right-0',
        )}
      >
        {label}
      </span>
    </span>
  )
}
