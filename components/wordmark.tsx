import { cn } from '@/lib/utils'

/** The Corpus wordmark: the name in the display face, nothing drawn around it. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('text-[15px] font-medium tracking-tight text-foreground', className)}>Corpus</span>
}

/** The rail's square mark: the initial inside a hairline, where the full name does not fit. */
export function Monogram({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('flex size-9 shrink-0 select-none items-center justify-center rounded-md border border-rule-2 bg-paper-3 text-[15px] font-medium text-foreground', className)}
    >
      C
    </span>
  )
}
