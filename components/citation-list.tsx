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
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <BookOpen className="size-3.5" />
        Sources <span className="measured text-cool">{citations.length}</span>
      </p>
      <div className="overflow-hidden rounded-md border border-border">
        {citations.map((citation) => (
          <button
            key={citation.index}
            type="button"
            aria-expanded={open === citation.index}
            onClick={() => setOpen(open === citation.index ? null : citation.index)}
            className={cn(
              'grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-2 text-left text-[13px] transition-colors duration-micro [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border',
              open === citation.index ? 'bg-paper-3 text-foreground' : 'bg-card text-ink-2 hover:bg-secondary hover:text-foreground',
            )}
          >
            <span className="measured text-cool">[{citation.index}]</span>
            <span className="truncate">{citation.title}</span>
            {typeof citation.relevance === 'number' ? (
              <span className="measured shrink-0 text-xs text-ink-2" title="Re-ranker relevance (0 to 1)">
                {citation.relevance.toFixed(2)}
              </span>
            ) : citation.similarity !== null ? (
              <span className="measured shrink-0 text-xs text-muted-foreground" title="Cosine similarity (0 to 1)">
                {citation.similarity.toFixed(2)}
              </span>
            ) : (
              <span />
            )}
          </button>
        ))}
      </div>
      {active && (
        <div className="mt-2 animate-slide-down rounded-md border border-border bg-paper-3 p-3 text-[13px] leading-relaxed">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate font-medium">{active.source}</span>
            <span className="flex shrink-0 items-center gap-3">
              {onOpenSource && active.documentId && (
                <button
                  type="button"
                  onClick={() => onOpenSource(active.documentId!, active.chunkId)}
                  className="flex items-center gap-1 font-medium text-foreground underline decoration-rule-2 underline-offset-4 hover:decoration-signal"
                >
                  <BookOpenText className="size-3" /> Read in document
                </button>
              )}
              {activeUrl && (
                <a
                  href={activeUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="flex items-center gap-1 text-foreground underline decoration-rule-2 underline-offset-4 hover:decoration-signal"
                >
                  Open <ExternalLink className="size-2.5" />
                </a>
              )}
            </span>
          </div>
          <blockquote className="whitespace-pre-wrap border-l-2 border-cool pl-2.5 text-ink-2">{active.excerpt}</blockquote>
        </div>
      )}
    </div>
  )
}
