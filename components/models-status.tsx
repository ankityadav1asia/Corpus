'use client'

import { Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/feedback-primitives'
import { useToast } from '@/components/ui/use-toast'
import { useModelsStatus } from '@/hooks/use-api'
import { apiJson, errorMessage } from '@/lib/api-client'
import type { ModelInfo, ModelsStatus } from '@/lib/contracts'
import { cn } from '@/lib/utils'

const ROWS: Array<{ key: keyof ModelsStatus['models']; label: string; hint: string }> = [
  { key: 'chat', label: 'Answers & reasoning', hint: 'Chat answers, reports, audio scripts, mind maps' },
  { key: 'fast', label: 'Quick helper calls', hint: 'Re-ranking, deep-search planning, follow-ups, quality scores' },
  { key: 'embeddings', label: 'Search embeddings', hint: 'Turns passages and questions into vectors' },
  { key: 'vision', label: 'Reading images', hint: 'Describes images and diagrams you upload' },
  { key: 'ocr', label: 'OCR', hint: 'Text in scanned PDFs and images' },
  { key: 'transcription', label: 'Transcription', hint: 'Audio and video sources' },
  { key: 'speech', label: 'Speech', hint: 'Voices of audio overviews' },
  { key: 'image', label: 'Image generation', hint: 'Image studio' },
]

function providerLabel(info: ModelInfo): string {
  if (info.provider === 'gemini') return /^gemma/i.test(info.model) ? 'Gemini API · open model' : 'Gemini API'
  if (info.provider === 'openai-compatible') return 'Open-source server'
  if (info.provider === 'tesseract') return 'Local · open source'
  return info.provider
}

/** Which model does what on this server, and re-embedding after an embedding-model change (admins). */
export function ModelsStatusView({ workspaceId, isAdmin }: { workspaceId: string | null; isAdmin: boolean }) {
  const { toast } = useToast()
  const status = useModelsStatus(workspaceId)
  const [busy, setBusy] = useState(false)
  const data = status.data

  async function reembed() {
    if (!workspaceId) return
    setBusy(true)
    try {
      await apiJson(`/api/workspaces/${workspaceId}/reembed`, { method: 'POST', workspaceId: null })
      toast({ description: 'Re-embedding started. Search keeps working meanwhile.' })
      await status.mutate()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  if (!data) return <Skeleton className="h-40 rounded-xl" />
  const { stale, total, reembedding } = data.embeddings

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border/50 rounded-xl border border-border/60">
        {ROWS.map((row) => {
          const info = data.models[row.key]
          return (
            <li key={row.key} className="flex items-center gap-3 px-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{row.label}</p>
                <p className="truncate text-[10px] text-muted-foreground">{row.hint}</p>
              </div>
              {info ? (
                <div className="min-w-0 text-right">
                  <p className="truncate font-mono text-[11px]">{info.model}</p>
                  <p className="text-[10px] text-muted-foreground">{providerLabel(info)}</p>
                </div>
              ) : (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Off</span>
              )}
            </li>
          )
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">Models are chosen in the server configuration (CHAT_PROVIDER, EMBEDDING_PROVIDER, …; see the README).</p>
      {total > 0 && (
        <div className={cn('flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-xs', stale ? 'border-warning/40 bg-warning/10' : 'border-border/60 bg-card/50')}>
          <p className="min-w-0 flex-1">
            {reembedding
              ? `Re-embedding… ${total - stale} of ${total} passages use the current model.`
              : stale
                ? `${stale} of ${total} passages were embedded by an older model and are found by keyword search only.`
                : `All ${total} passages use the current embedding model.`}
          </p>
          {isAdmin && stale > 0 && (
            <Button type="button" size="sm" variant="outline" disabled={busy || reembedding} onClick={() => void reembed()}>
              {busy || reembedding ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
              Re-embed
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
