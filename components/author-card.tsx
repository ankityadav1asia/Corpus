import { Linkedin, Mail } from 'lucide-react'

import { AUTHOR } from '@/lib/author'
import { cn } from '@/lib/utils'

const iconLink =
  'flex size-8 items-center justify-center rounded-md border border-rule-2 text-muted-foreground transition-colors duration-micro hover:bg-secondary hover:text-foreground'

/** The author's photo with LinkedIn and email links, for visitors who want to get in touch. */
export function AuthorCard({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a 5 KB WebP from public/ */}
      <img src={AUTHOR.photo} alt={AUTHOR.name} width={32} height={32} className="size-8 rounded-md border border-rule object-cover" />
      <div className="hidden leading-tight sm:block">
        <div className="text-[13px] font-medium">{AUTHOR.name}</div>
        <div className="text-xs text-muted-foreground">Built Corpus. Get in touch.</div>
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
