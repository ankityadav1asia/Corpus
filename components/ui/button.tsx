import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md border text-sm font-medium transition-colors duration-micro ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-55',
  {
    variants: {
      variant: {
        // The one amber control on a screen.
        default: 'border-primary bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80',
        brand: 'border-primary bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80',
        destructive: 'border-rule-2 bg-card text-bad hover:border-bad hover:bg-bad-soft active:bg-bad-soft/70',
        outline: 'border-rule-2 bg-card text-foreground hover:bg-secondary active:bg-paper-3',
        secondary: 'border-rule bg-secondary text-ink-2 hover:text-foreground active:bg-paper',
        ghost: 'border-transparent text-ink-2 hover:bg-secondary hover:text-foreground active:bg-paper',
        link: 'border-transparent text-foreground underline decoration-rule-2 underline-offset-4 hover:decoration-signal',
      },
      size: {
        default: 'h-9 px-3.5',
        sm: 'h-8 px-2.5 text-[13px]',
        lg: 'h-10 px-5',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
})
Button.displayName = 'Button'

export { Button, buttonVariants }
