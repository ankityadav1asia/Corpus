import { Linkedin, Mail } from 'lucide-react'

import { AUTHOR } from '@/lib/author'
import { cn } from '@/lib/utils'

const iconLink =
  'flex size-8 items-center justify-center rounded-full border border-border bg-background/60 text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground'

/** The author's photo with LinkedIn and email links, for visitors who want to get in touch. */
export function AuthorCard({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5 rounded-full border border-border/80 bg-card/80 py-1.5 pl-1.5 pr-2 shadow-lg backdrop-blur', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a 5 KB WebP from public/ */}
      <img src={AUTHOR.photo} alt={AUTHOR.name} width={36} height={36} className="size-9 rounded-full object-cover" />
      <div className="hidden leading-tight sm:block">
        <div className="text-sm font-medium">{AUTHOR.name}</div>
        <div className="text-[11px] text-muted-foreground">Built Corpus · get in touch</div>
      </div>
      <a href={AUTHOR.linkedin} target="_blank" rel="noreferrer" aria-label={`${AUTHOR.name} on LinkedIn`} title="LinkedIn" className={iconLink}>
        <Linkedin className="size-4" />
      </a>
      <a href={`mailto:${AUTHOR.email}`} aria-label={`Email ${AUTHOR.name}`} title={AUTHOR.email} className={iconLink}>
        <Mail className="size-4" />
      </a>
    </div>
  )
}
