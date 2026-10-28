import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium transition-colors duration-micro focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  {
    variants: {
      variant: {
        // A chip carries state only: amber for a person's choice, cool for what the system recorded.
        default: 'border-signal/40 bg-signal-soft text-foreground',
        secondary: 'border-cool/40 bg-cool-soft text-foreground',
        destructive: 'border-bad/40 bg-bad-soft text-foreground',
        outline: 'border-rule-2 text-ink-2',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
