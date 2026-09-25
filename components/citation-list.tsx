'use client'

import { BookOpen, BookOpenText, ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { safeExternalUrl } from '@/lib/api-client'
import type { Citation } from '@/lib/contracts'
import { cn } from '@/lib/utils'

interface CitationListProps {
  citations: Citation[]
  /** Opens the full document with this passage highlighted. */
  onOpenSource?: (documentId: string, chunkId: string | null) => void
}

export function CitationList({ citations, onOpenSource }: CitationListProps) {
  const [open, setOpen] = useState<number | null>(null)
  if (citations.length === 0) return null
  const active = citations.find((citation) => citation.index === open)
  const activeUrl = safeExternalUrl(active?.source)

  return (
    <div className="mt-4">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <BookOpen className="size-3.5 text-primary" />
        Sources ({citations.length})
      </p>
      <div className="flex flex-wrap gap-1.5">
        {citations.map((citation) => (
          <button
            key={citation.index}
            type="button"
            aria-expanded={open === citation.index}
            onClick={() => setOpen(open === citation.index ? null : citation.index)}
            className={cn(
              'flex max-w-[260px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-all',
              open === citation.index
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-border/70 bg-card/60 text-muted-foreground hover:-translate-y-px hover:border-primary/40 hover:text-foreground',
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">{citation.index}</span>
            <span className="truncate">{citation.title}</span>
            {typeof citation.relevance === 'number' ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 font-mono text-[10px] text-primary" title="Re-ranker relevance (0–1)">
                {citation.relevance.toFixed(2)}
              </span>
            ) : (
              citation.similarity !== null && (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title="Cosine similarity (0–1)">
                  {citation.similarity.toFixed(2)}
                </span>
              )
            )}
          </button>
        ))}
      </div>
      {active && (
        <div className="mt-2 animate-slide-down rounded-2xl border border-primary/25 bg-card/70 p-3 text-xs leading-relaxed">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span className="truncate font-semibold">{active.source}</span>
            <span className="flex shrink-0 items-center gap-3">
              {onOpenSource && active.documentId && (
                <button type="button" onClick={() => onOpenSource(active.documentId!, active.chunkId)} className="flex items-center gap-1 font-medium text-primary hover:underline">
                  <BookOpenText className="size-3" /> Read in document
                </button>
              )}
              {activeUrl && (
                <a href={activeUrl} target="_blank" rel="noopener noreferrer nofollow" className="flex items-center gap-1 text-primary hover:underline">
                  Open <ExternalLink className="size-2.5" />
                </a>
              )}
            </span>
          </div>
          <blockquote className="whitespace-pre-wrap border-l-2 border-primary/50 pl-2.5 text-foreground/85">{active.excerpt}</blockquote>
        </div>
      )}
    </div>
  )
}
