import * as React from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'

/** Styled native <select>: accessible and keyboard-friendly without a headless-UI dependency. */
const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <div className="relative">
    <select
      ref={ref}
      className={cn(
        'h-9 w-full appearance-none truncate rounded-xl border border-border/80 bg-card/60 pl-3 pr-8 text-xs font-medium text-foreground transition-[border-color,box-shadow] hover:border-primary/40 focus:border-primary/50 focus:outline-none focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
  </div>
))
Select.displayName = 'Select'

export { Select }
