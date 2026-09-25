'use client'

import { ExternalLink, FileText, FileType2, Search } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'

import { PdfViewer } from '@/components/pdf-viewer'
import { Drawer } from '@/components/ui/drawer'
import { Skeleton } from '@/components/ui/feedback-primitives'
import { useDocumentDetail } from '@/hooks/use-api'
import { errorMessage, safeExternalUrl } from '@/lib/api-client'
import { formatBytes, plural, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

interface SourceViewerProps {
  documentId: string | null
  /** Passage to highlight and scroll to (e.g. the one a citation points at). */
  chunkId?: string | null
  onClose: () => void
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Wraps case-insensitive matches of `term` in <mark>. */
function Highlighted({ text, term }: { text: string; term: string }) {
  if (term.length < 2) return <>{text}</>
  const parts = text.split(new RegExp(`(${escapeRegExp(term)})`, 'gi'))
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="rounded bg-warning/30 px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  )
}

/** Reads a document in full, rebuilt from its passages, with the cited passage highlighted. */
export function SourceViewer({ documentId, chunkId, onClose }: SourceViewerProps) {
  const detail = useDocumentDetail(documentId)
  const [term, setTerm] = useState('')
  const document = detail.data?.document
  const link = safeExternalUrl(document?.source)
  // Counts what is highlighted: every occurrence, not the passages containing one.
  const pattern = term.length >= 2 ? new RegExp(escapeRegExp(term), 'gi') : null
  const matches = pattern ? (detail.data?.chunks.reduce((total, chunk) => total + (chunk.content.match(pattern)?.length ?? 0), 0) ?? 0) : null

  const hasPdf = detail.data?.file?.mimeType === 'application/pdf'
  const [view, setView] = useState<'pdf' | 'text'>('pdf')
  const showPdf = hasPdf && view === 'pdf' && documentId !== null
  const citedPassage = chunkId ? (detail.data?.chunks.find((chunk) => chunk.id === chunkId)?.content ?? null) : null

  useEffect(() => {
    setTerm('')
    setView('pdf')
  }, [documentId])

  useEffect(() => {
    if (!chunkId || !detail.data || showPdf) return
    const frame = requestAnimationFrame(() => window.document.getElementById(`passage-${chunkId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [chunkId, detail.data, showPdf])

  return (
    <Drawer
      open={documentId !== null}
      onClose={onClose}
      title={document?.title ?? 'Source'}
      className={showPdf ? 'max-w-3xl' : 'max-w-2xl'}
      description={
        document && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {plural(document.chunkCount, 'passage')}
              {document.byteSize ? ` · ${formatBytes(document.byteSize)}` : ''} · added {timeAgo(document.createdAt)}
            </span>
            {link && (
              <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-primary hover:underline">
                Open original <ExternalLink className="size-3" />
              </a>
            )}
          </span>
        )
      }
    >
      {hasPdf && (
        <div className="flex gap-1 border-b border-border/50 px-5 py-2" role="tablist" aria-label="View">
          {(['pdf', 'text'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              onClick={() => setView(option)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                view === option ? 'bg-primary/10 text-foreground ring-1 ring-primary/30' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              {option === 'pdf' ? <FileType2 className="size-3.5" /> : <FileText className="size-3.5" />}
              {option === 'pdf' ? 'Original PDF' : 'Extracted text'}
            </button>
          ))}
        </div>
      )}
      {showPdf ? (
        <PdfViewer documentId={documentId!} passage={citedPassage} />
      ) : (
        <>
          <div className="border-b border-border/50 px-5 py-3">
            <label className="composer flex items-center gap-2 px-3 py-1.5">
              <Search className="size-3.5 text-muted-foreground" />
              <span className="sr-only">Search in this document</span>
              <input
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Search in this document…"
                className="w-full bg-transparent text-xs focus:outline-none"
              />
              {matches !== null && (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {matches} match{matches === 1 ? '' : 'es'}
                </span>
              )}
            </label>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {detail.isLoading ? (
              <div className="space-y-3">
                {[0, 1, 2, 3].map((key) => (
                  <Skeleton key={key} className="h-16" />
                ))}
              </div>
            ) : detail.error ? (
              <p className="py-10 text-center text-sm text-destructive">{errorMessage(detail.error)}</p>
            ) : (
              <article className="space-y-1">
                {detail.data?.chunks.map((chunk) => (
                  <div
                    key={chunk.id}
                    id={`passage-${chunk.id}`}
                    className={cn(
                      'group relative rounded-xl px-3 py-2 text-[13px] leading-relaxed transition-colors',
                      chunk.id === chunkId ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-secondary/50',
                    )}
                  >
                    <span className="absolute -left-1 top-2 hidden font-mono text-[9px] text-muted-foreground group-hover:block">{chunk.chunkIndex + 1}</span>
                    <p className="whitespace-pre-wrap text-foreground/90">
                      <Highlighted text={chunk.content} term={term} />
                    </p>
                    {chunk.id === chunkId && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                        <FileText className="size-3" /> Cited passage
                      </span>
                    )}
                  </div>
                ))}
              </article>
            )}
          </div>
        </>
      )}
    </Drawer>
  )
}
