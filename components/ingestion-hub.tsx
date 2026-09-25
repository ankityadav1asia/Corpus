'use client'

import { FileText, Globe, Loader2, Plug, Upload, Youtube } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { ConnectorsPanel } from '@/components/connectors-panel'
import { FileUploadZone, UploadList } from '@/components/file-upload-zone'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import type { useUploads } from '@/hooks/use-uploads'
import { apiJson, errorMessage } from '@/lib/api-client'
import { LIMITS } from '@/lib/constants'
import type { QueuedIngest } from '@/lib/contracts'
import { cn } from '@/lib/utils'

export type IngestionTab = 'files' | 'apps' | 'url' | 'youtube' | 'text'
type Tab = IngestionTab

const TABS: Array<{ id: Tab; label: string; icon: typeof Upload }> = [
  { id: 'files', label: 'Files', icon: Upload },
  { id: 'apps', label: 'Apps', icon: Plug },
  { id: 'url', label: 'Website', icon: Globe },
  { id: 'youtube', label: 'YouTube', icon: Youtube },
  { id: 'text', label: 'Text', icon: FileText },
]

interface IngestionHubProps {
  collectionId: string | null
  disabled?: boolean
  onIngested: () => void
  uploads: ReturnType<typeof useUploads>
  /** Tab to show first (e.g. Apps after connecting Google Drive). */
  initialTab?: IngestionTab
}

/** Add-source forms. Sources are accepted immediately and indexed in the background. */
export function IngestionHub({ collectionId, disabled, onIngested, uploads, initialTab = 'files' }: IngestionHubProps) {
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('')
  const [video, setVideo] = useState('')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const locked = disabled || busy || !collectionId

  async function queue(path: string, body: Record<string, unknown>, reset: () => void) {
    if (!collectionId) return
    setBusy(true)
    try {
      const { document } = await apiJson<QueuedIngest>(path, { method: 'POST', json: { collectionId, ...body } })
      reset()
      toast({ title: 'Source added', description: `“${document.title}” is being indexed — you can keep working.` })
      onIngested()
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not add source', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const submitUrl = (event: FormEvent) => {
    event.preventDefault()
    void queue('/api/learn/url', { url }, () => setUrl(''))
  }
  const submitVideo = (event: FormEvent) => {
    event.preventDefault()
    void queue('/api/learn/youtube', { url: video }, () => setVideo(''))
  }
  const submitText = (event: FormEvent) => {
    event.preventDefault()
    void queue('/api/learn', { title: title.trim() || undefined, text }, () => {
      setText('')
      setTitle('')
    })
  }

  return (
    <section className="border-b border-border/50 p-4">
      <div role="tablist" aria-label="Source type" className="mb-3 grid grid-cols-5 gap-1 rounded-xl border border-border/70 bg-muted/40 p-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-[11px] font-medium transition-all',
              tab === id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      {!collectionId && <p className="mb-3 text-xs text-muted-foreground">Create or select a notebook first.</p>}

      {tab === 'files' && (
        <div>
          <FileUploadZone
            disabled={disabled || !collectionId}
            onFiles={(files) => collectionId && void uploads.upload(files, collectionId)}
            onReject={(message) => toast({ variant: 'destructive', description: message })}
          />
          <UploadList items={uploads.items} onDismiss={uploads.dismiss} />
        </div>
      )}

      {tab === 'apps' && <ConnectorsPanel collectionId={collectionId} canEdit onChanged={onIngested} />}

      {tab === 'url' && (
        <form onSubmit={submitUrl} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="source-url">Public web page</Label>
            <Input
              id="source-url"
              type="url"
              required
              maxLength={LIMITS.urlChars}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/article"
              disabled={locked}
            />
            <p className="text-[11px] text-muted-foreground">Private network, localhost and cloud-metadata addresses are blocked.</p>
          </div>
          <Button type="submit" size="sm" className="w-full" disabled={locked || !url.trim()}>
            {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
            {busy ? 'Fetching…' : 'Add website'}
          </Button>
        </form>
      )}

      {tab === 'youtube' && (
        <form onSubmit={submitVideo} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="source-youtube">YouTube link</Label>
            <Input id="source-youtube" required value={video} onChange={(e) => setVideo(e.target.value)} placeholder="https://youtube.com/watch?v=…" disabled={locked} />
            <p className="text-[11px] text-muted-foreground">Uses the video’s captions; videos without captions cannot be imported.</p>
          </div>
          <Button type="submit" size="sm" className="w-full" disabled={locked || !video.trim()}>
            {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
            {busy ? 'Fetching transcript…' : 'Add video'}
          </Button>
        </form>
      )}

      {tab === 'text' && (
        <form onSubmit={submitText} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="source-title">Title (optional)</Label>
            <Input
              id="source-title"
              maxLength={LIMITS.documentTitleChars}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Meeting notes, 12 March"
              disabled={locked}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="source-text">Text</Label>
            <Textarea
              id="source-text"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste notes, articles or any text…"
              disabled={locked}
              className="text-xs"
            />
            <p className={cn('text-right font-mono text-[10px] text-muted-foreground', text.length > LIMITS.documentChars && 'text-destructive')}>
              {text.length.toLocaleString()} / {LIMITS.documentChars.toLocaleString()}
            </p>
          </div>
          <Button type="submit" size="sm" className="w-full" disabled={locked || !text.trim() || text.length > LIMITS.documentChars}>
            {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
            {busy ? 'Adding…' : 'Add text'}
          </Button>
        </form>
      )}
    </section>
  )
}
