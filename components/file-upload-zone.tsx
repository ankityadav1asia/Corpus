'use client'

import { CheckCircle2, FileText, Loader2, UploadCloud, X, XCircle } from 'lucide-react'
import { useRef, useState } from 'react'

import { Progress } from '@/components/ui/feedback-primitives'
import type { UploadItem } from '@/hooks/use-uploads'
import { ACCEPTED_FILE_EXTENSIONS, ACCEPTED_FILE_TYPES, LIMITS } from '@/lib/constants'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

function extension(name: string) {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/** Checks type, size and emptiness like the server does; returns the files that pass. */
export function acceptFiles(list: FileList | File[], onReject: (message: string) => void): File[] {
  const accepted: File[] = []
  for (const file of Array.from(list)) {
    if (!(ACCEPTED_FILE_EXTENSIONS as readonly string[]).includes(extension(file.name))) onReject(`"${file.name}" is not a supported file type.`)
    else if (file.size > LIMITS.fileBytes) onReject(`"${file.name}" is larger than ${formatBytes(LIMITS.fileBytes)}.`)
    else if (file.size === 0) onReject(`"${file.name}" is empty.`)
    else accepted.push(file)
  }
  return accepted
}

interface FileUploadZoneProps {
  disabled?: boolean
  onFiles: (files: File[]) => void
  onReject: (message: string) => void
}

/** Drop zone / picker. Files start uploading as soon as they are chosen. */
export function FileUploadZone({ disabled, onFiles, onReject }: FileUploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function add(list: FileList | null) {
    if (!list || disabled) return
    const accepted = acceptFiles(list, onReject)
    if (accepted.length) onFiles(accepted)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div
      className={cn(
        'group relative flex flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed p-6 text-center transition-all',
        dragging ? 'scale-[1.01] border-primary bg-primary/10' : 'border-border/80 hover:border-primary/50 hover:bg-accent/40',
        disabled && 'pointer-events-none opacity-50',
      )}
      onDragEnter={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        add(event.dataTransfer.files)
      }}
    >
      <input ref={inputRef} type="file" multiple accept={ACCEPTED_FILE_TYPES} className="sr-only" tabIndex={-1} onChange={(event) => add(event.target.files)} />
      <div className={cn('mb-2 flex size-11 items-center justify-center rounded-xl bg-brand-soft transition-transform', dragging ? 'scale-110' : 'group-hover:-translate-y-0.5')}>
        <UploadCloud className="size-5 text-primary" />
      </div>
      <p className="text-xs">
        Drop files here or{' '}
        <button type="button" onClick={() => inputRef.current?.click()} className="font-semibold text-primary underline-offset-2 hover:underline">
          browse
        </button>
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Documents (PDF incl. scans, TXT, MD, CSV, JSON, HTML), images, audio and video · up to {formatBytes(LIMITS.fileBytes)} per file
      </p>
    </div>
  )
}

/** Per-file upload status with progress bars. */
export function UploadList({ items, onDismiss }: { items: UploadItem[]; onDismiss: (id: string) => void }) {
  if (items.length === 0) return null
  return (
    <ul className="mt-3 space-y-2">
      {items.map((item) => (
        <li key={item.id} className="animate-fade-up rounded-xl border border-border/60 bg-card/60 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            {item.status === 'queued' ? (
              <CheckCircle2 className="size-4 shrink-0 text-success" />
            ) : item.status === 'error' ? (
              <XCircle className="size-4 shrink-0 text-destructive" />
            ) : item.status === 'uploading' ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium" title={item.name}>
              {item.name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {item.status === 'uploading' ? `${Math.round(item.progress * 100)}% · ` : ''}
              {formatBytes(item.size)}
            </span>
            {(item.status === 'queued' || item.status === 'error') && (
              <button type="button" aria-label={`Dismiss ${item.name}`} onClick={() => onDismiss(item.id)} className="shrink-0 text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </div>
          {item.status === 'uploading' && <Progress value={item.progress} className="mt-2" label={`Uploading ${item.name}`} />}
          {item.status === 'waiting' && <p className="mt-1 text-[11px] text-muted-foreground">Waiting…</p>}
          {item.status === 'queued' && <p className="mt-1 text-[11px] text-muted-foreground">Uploaded — indexing continues in the background.</p>}
          {item.status === 'error' && <p className="mt-1 text-[11px] text-destructive">{item.error}</p>}
        </li>
      ))}
    </ul>
  )
}
