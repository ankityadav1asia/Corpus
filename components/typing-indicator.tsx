export function TypingIndicator({ label = 'Searching your notebooks…' }: { label?: string }) {
  return (
    <span role="status" className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 animate-pulse-dot rounded-full bg-primary" style={{ animationDelay: `${i * 0.16}s` }} />
        ))}
      </span>
      {label}
    </span>
  )
}
