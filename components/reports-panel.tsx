'use client'

import { AlertCircle, Check, CheckCircle2, Copy, Download, FileBarChart, FileText, Loader2, Plus, Presentation, Share2, Table2, Trash2, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import Markdown from '@/components/markdown'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { ShareDialog } from '@/components/share-dialog'
import { useWorkspaceContext } from '@/components/workspace-provider'
import { atLeast, canManageOwned } from '@/lib/roles'
import { useDocuments, useReport, useReports } from '@/hooks/use-api'
import { apiJson, errorMessage } from '@/lib/api-client'
import { LIMITS, type ReportTemplate } from '@/lib/constants'
import type { Collection, JobStatus, ReportDetail, ReportSummary, SessionUser } from '@/lib/contracts'
import { downloadText, fileSlug } from '@/lib/download'
import { cn } from '@/lib/utils'

const TEMPLATES: Array<{ id: ReportTemplate; label: string; description: string; icon: typeof FileText }> = [
  { id: 'executive_summary', label: 'Executive summary', description: 'Key findings, risks and next steps across the sources', icon: FileText },
  { id: 'comparison_table', label: 'Comparison table', description: 'Side-by-side table of scope, findings, numbers and limits', icon: Table2 },
  { id: 'slide_outline', label: 'Slide outline', description: '6–10 slides with bullets and speaker notes (Markdown or JSON)', icon: Presentation },
]

const TEMPLATE_LABEL = Object.fromEntries(TEMPLATES.map((template) => [template.id, template.label])) as Record<ReportTemplate, string>

function StatusBadge({ status, progress }: { status: JobStatus; progress?: string | null }) {
  if (status === 'completed')
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/40 font-mono text-[10px] text-emerald-500">
        <CheckCircle2 className="size-3" /> Ready
      </Badge>
    )
  if (status === 'failed')
    return (
      <Badge variant="outline" className="gap-1 border-destructive/40 font-mono text-[10px] text-destructive">
        <AlertCircle className="size-3" /> Failed
      </Badge>
    )
  return (
    <Badge variant="outline" className="gap-1 border-primary/40 font-mono text-[10px] text-primary">
      <Loader2 className="size-3 animate-spin" /> {progress ?? (status === 'queued' ? 'Queued' : 'Working')}
    </Badge>
  )
}

function NewReportForm({ collections, onCreated, onCancel }: { collections: Collection[]; onCreated: (report: ReportSummary) => void; onCancel: () => void }) {
  const { toast } = useToast()
  const [template, setTemplate] = useState<ReportTemplate>('executive_summary')
  const [format, setFormat] = useState<'markdown' | 'json'>('markdown')
  const [notebooks, setNotebooks] = useState<string[]>([])
  const [documentsFrom, setDocumentsFrom] = useState(collections[0]?.id ?? '')
  const [documentIds, setDocumentIds] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const documents = useDocuments(documentsFrom || null)
  const readyDocuments = (documents.data?.documents ?? []).filter((document) => document.status === 'ready')

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id])
  const selectedCount = notebooks.length + documentIds.length

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const { report } = await apiJson<{ report: ReportSummary }>('/api/reports', {
        method: 'POST',
        json: {
          template,
          format: template === 'slide_outline' ? format : 'markdown',
          collectionIds: notebooks,
          documentIds,
          title: title.trim() || undefined,
          instructions: instructions.trim() || undefined,
        },
      })
      toast({ description: 'Report queued. It is written in the background — you can keep working.' })
      onCreated(report)
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-base font-semibold">New report</h3>
        <button type="button" aria-label="Close" onClick={onCancel} className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="mb-1.5 text-xs font-medium">Template</legend>
        {TEMPLATES.map(({ id, label, description, icon: Icon }) => (
          <label
            key={id}
            className={cn(
              'cursor-pointer rounded-xl border p-3 text-xs transition-colors',
              template === id ? 'border-primary/60 bg-primary/10' : 'border-border/60 bg-secondary/20 hover:border-primary/30',
            )}
          >
            <input type="radio" name="template" value={id} checked={template === id} onChange={() => setTemplate(id)} className="sr-only" />
            <span className="flex items-center gap-1.5 font-medium">
              <Icon className="size-3.5 text-primary" /> {label}
            </span>
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{description}</span>
          </label>
        ))}
      </fieldset>

      {template === 'slide_outline' && (
        <div className="flex items-center gap-3 text-xs">
          <span className="font-medium">Output</span>
          {(['markdown', 'json'] as const).map((value) => (
            <label key={value} className="flex items-center gap-1.5">
              <input type="radio" name="format" checked={format === value} onChange={() => setFormat(value)} />
              {value === 'markdown' ? 'Markdown' : 'JSON (validated slide structure)'}
            </label>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-xs font-medium">Whole notebooks</legend>
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
            {collections.map((collection) => (
              <label key={collection.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-secondary/40">
                <input type="checkbox" checked={notebooks.includes(collection.id)} onChange={() => setNotebooks(toggle(notebooks, collection.id))} />
                <span className="truncate">{collection.name}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{collection.documentCount}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-xs font-medium">Or specific documents</legend>
          <Select aria-label="Notebook to pick documents from" value={documentsFrom} onChange={(event) => setDocumentsFrom(event.target.value)}>
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
          </Select>
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
            {documents.isLoading ? (
              <Loader2 className="size-3.5 animate-spin text-primary" />
            ) : readyDocuments.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No indexed documents.</p>
            ) : (
              readyDocuments.map((document) => (
                <label key={document.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-secondary/40">
                  <input type="checkbox" checked={documentIds.includes(document.id)} onChange={() => setDocumentIds(toggle(documentIds, document.id))} />
                  <span className="truncate" title={document.source}>
                    {document.title}
                  </span>
                </label>
              ))
            )}
          </div>
        </fieldset>
      </div>
      <p className="text-[11px] text-muted-foreground">Up to {LIMITS.documentsPerReport} documents are synthesised (the most recent ones when a selection is larger).</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="report-title">Title (optional)</Label>
          <Input id="report-title" value={title} maxLength={LIMITS.documentTitleChars} onChange={(event) => setTitle(event.target.value)} className="h-9 text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="report-instructions">Focus (optional)</Label>
          <Textarea
            id="report-instructions"
            rows={2}
            value={instructions}
            maxLength={LIMITS.reportInstructionsChars}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="e.g. Focus on costs and timelines"
            className="min-h-[36px] text-xs"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || selectedCount === 0}>
          {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <FileBarChart className="mr-2 size-3.5" />}
          Generate report
        </Button>
      </div>
    </form>
  )
}

function ReportViewer({ report, canDelete, canShare, onDeleted }: { report: ReportDetail; canDelete: boolean; canShare: boolean; onDeleted: () => void }) {
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)
  const [sharing, setSharing] = useState(false)
  const slug = fileSlug(report.title)

  async function copy() {
    if (!report.content) return
    try {
      await navigator.clipboard.writeText(report.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable
    }
  }

  async function remove() {
    if (!window.confirm(`Delete the report “${report.title}”?`)) return
    try {
      await apiJson(`/api/reports/${report.id}`, { method: 'DELETE' })
      onDeleted()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 pb-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold">{report.title}</h3>
          <p className="font-mono text-[11px] text-muted-foreground">
            {TEMPLATE_LABEL[report.template]} · {report.format === 'json' ? 'JSON' : 'Markdown'} · {new Date(report.createdAt).toLocaleString()}
            {report.createdByEmail && ` · ${report.createdByEmail}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={report.status} progress={report.progress} />
          {report.content && (
            <>
              <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={copy}>
                {copied ? <Check className="mr-1.5 size-3.5" /> : <Copy className="mr-1.5 size-3.5" />}
                Copy
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => downloadText(`${slug}.md`, 'text/markdown', report.content!)}>
                <Download className="mr-1.5 size-3.5" />
                .md
              </Button>
              {report.status === 'completed' && (
                <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setSharing(true)}>
                  <Share2 className="mr-1.5 size-3.5" />
                  Share
                </Button>
              )}
              <ShareDialog open={sharing} onClose={() => setSharing(false)} kind="report" targetId={report.id} title={report.title} canShare={canShare} />
            </>
          )}
          {report.output && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => downloadText(`${slug}.json`, 'application/json', JSON.stringify(report.output, null, 2))}
            >
              <Download className="mr-1.5 size-3.5" />
              .json
            </Button>
          )}
          {canDelete && (
            <button type="button" aria-label="Delete report" onClick={remove} className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </header>

      {report.instructions && <p className="rounded-lg border border-border/50 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">Focus: {report.instructions}</p>}

      {report.status === 'failed' ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {report.error ?? 'The report could not be generated.'}
        </p>
      ) : !report.content ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-6 animate-spin text-primary" />
          {report.progress ?? 'Waiting for a worker…'}
        </div>
      ) : report.output ? (
        <ol className="grid gap-3 md:grid-cols-2">
          {report.output.slides.map((slide, index) => (
            <li key={index} className="rounded-xl border border-border/60 bg-card/60 p-4">
              <p className="font-mono text-[10px] uppercase tracking-wider text-primary">Slide {index + 1}</p>
              <h4 className="mt-1 font-display text-sm font-semibold">{slide.title}</h4>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-foreground/85">
                {slide.bullets.map((bullet, bulletIndex) => (
                  <li key={bulletIndex}>{bullet}</li>
                ))}
              </ul>
              {slide.notes && <p className="mt-2 border-t border-border/40 pt-2 text-[11px] italic text-muted-foreground">{slide.notes}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <Markdown content={report.content} />
      )}

      {report.sources.length > 0 && (
        <footer className="border-t border-border/50 pt-3">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Sources [n]</p>
          <ol className="space-y-0.5 text-xs text-muted-foreground">
            {report.sources.map((source, index) => (
              <li key={source.documentId}>
                <span className="font-mono text-primary">[{index + 1}]</span> {source.title}
              </li>
            ))}
          </ol>
        </footer>
      )}
    </div>
  )
}

/** Multi-document synthesis: queue a report, watch its progress, read and download it. */
export function ReportsPanel({
  collections,
  user,
  focusId,
  onFocusConsumed,
}: {
  collections: Collection[]
  user: SessionUser
  /** Report to open (e.g. from a notification). */
  focusId?: string | null
  onFocusConsumed?: () => void
}) {
  const { role } = useWorkspaceContext()
  const reports = useReports()
  const [creating, setCreating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const report = useReport(selectedId)
  const list = reports.data?.reports ?? []
  const newestId = list[0]?.id ?? null

  useEffect(() => {
    if (!focusId) return
    setSelectedId(focusId)
    setCreating(false)
    onFocusConsumed?.()
  }, [focusId, onFocusConsumed])

  // Open the newest report by default. (The open report polls itself while it is being written.)
  useEffect(() => {
    if (!selectedId && !creating && newestId) setSelectedId(newestId)
  }, [newestId, selectedId, creating])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      <aside className="flex max-h-72 shrink-0 flex-col gap-3 lg:max-h-none lg:w-72">
        <Button type="button" size="sm" onClick={() => setCreating(true)} disabled={collections.length === 0}>
          <Plus className="mr-2 size-3.5" />
          New report
        </Button>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {reports.isLoading ? (
            <Loader2 className="mx-auto mt-6 size-5 animate-spin text-primary" />
          ) : list.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No reports yet. Generate an executive summary, comparison table or slide outline from your sources.
            </p>
          ) : (
            list.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => {
                  setSelectedId(entry.id)
                  setCreating(false)
                }}
                className={cn(
                  'w-full rounded-xl border px-3 py-2.5 text-left text-xs transition-colors',
                  entry.id === selectedId && !creating ? 'border-primary/50 bg-primary/10' : 'border-border/50 bg-secondary/20 hover:border-primary/30',
                )}
              >
                <p className="truncate font-medium">{entry.title}</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[10px] text-muted-foreground">{TEMPLATE_LABEL[entry.template]}</span>
                  <StatusBadge status={entry.status} progress={entry.status === 'running' ? null : entry.progress} />
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/60 bg-card/40 p-5">
        {creating ? (
          <NewReportForm
            collections={collections}
            onCancel={() => setCreating(false)}
            onCreated={(created) => {
              setCreating(false)
              setSelectedId(created.id)
              void reports.mutate()
            }}
          />
        ) : report.data ? (
          <ReportViewer
            report={report.data.report}
            canDelete={canManageOwned(role, report.data.report.createdByEmail, user.email)}
            canShare={atLeast(role, 'editor')}
            onDeleted={() => {
              setSelectedId(null)
              void reports.mutate()
            }}
          />
        ) : selectedId && report.error ? (
          <p className="py-10 text-center text-sm text-destructive">{errorMessage(report.error)}</p>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <FileBarChart className="size-8 opacity-40" />
            <p className="text-sm">Select a report or create a new one.</p>
          </div>
        )}
      </section>
    </div>
  )
}
