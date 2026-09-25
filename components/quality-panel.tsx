'use client'

import { AlertTriangle, FlaskConical, Gauge, Loader2, MessageSquareQuote, Play, Plus, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { METRICS, formatScore, scoreTone } from '@/components/quality-badges'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { useWorkspaceContext } from '@/components/workspace-provider'
import { useEvalCases, useEvalRuns, useQuality } from '@/hooks/use-api'
import { apiJson, errorMessage } from '@/lib/api-client'
import { LIMITS } from '@/lib/constants'
import { timeAgo } from '@/lib/format'
import type { Collection, EvaluationScores } from '@/lib/contracts'
import { atLeast } from '@/lib/roles'
import { cn } from '@/lib/utils'

function ScoreChips({ scores }: { scores: EvaluationScores }) {
  return (
    <div className="flex flex-wrap gap-1">
      {METRICS.filter((metric) => scores[metric.key] !== null).map((metric) => (
        <span key={metric.key} title={metric.description} className={cn('rounded border px-1 py-0.5 font-mono text-[10px]', scoreTone(scores[metric.key]))}>
          {metric.label.split(' ')[0]} {formatScore(scores[metric.key])}
        </span>
      ))}
    </div>
  )
}

function Bar({ value }: { value: number | null }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" title={formatScore(value)}>
      <div
        className={cn('h-full rounded-full', value === null ? '' : value >= 0.8 ? 'bg-emerald-500' : value >= 0.5 ? 'bg-amber-500' : 'bg-red-500')}
        style={{ width: `${Math.round((value ?? 0) * 100)}%` }}
      />
    </div>
  )
}

/** LLM-as-judge quality of live answers, plus benchmark runs against reference answers. */
export function QualityPanel({ collections }: { collections: Collection[] }) {
  const { toast } = useToast()
  const { role } = useWorkspaceContext()
  const canManage = atLeast(role, 'editor')
  const [days, setDays] = useState(30)
  const quality = useQuality(days)
  const cases = useEvalCases()
  const runs = useEvalRuns()
  const [question, setQuestion] = useState('')
  const [reference, setReference] = useState('')
  const [caseNotebook, setCaseNotebook] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const data = quality.data
  const runList = runs.data?.runs ?? []
  const caseList = cases.data?.cases ?? []
  const runActive = runList.some((run) => run.status === 'queued' || run.status === 'running')
  const notebookName = (id: string | null) => (id ? (collections.find((c) => c.id === id)?.name ?? 'Deleted notebook') : 'All notebooks')

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key)
    try {
      await action()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const addCase = (event: FormEvent) => {
    event.preventDefault()
    void run('case', async () => {
      await apiJson('/api/evaluations/cases', {
        method: 'POST',
        json: { question: question.trim(), referenceAnswer: reference.trim(), collectionId: caseNotebook || null },
      })
      setQuestion('')
      setReference('')
      await cases.mutate()
    })
  }

  const deleteCase = (id: string) =>
    void run(`delete:${id}`, async () => {
      await apiJson(`/api/evaluations/cases/${id}`, { method: 'DELETE' })
      await cases.mutate()
    })

  const startRun = () =>
    void run('run', async () => {
      await apiJson('/api/evaluations/runs', { method: 'POST' })
      await runs.mutate()
      toast({ description: 'Benchmark started. Every question is answered by the live pipeline and scored in the background.' })
    })

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
          <div>
            <h3 className="flex items-center gap-2 font-display text-base font-semibold">
              <Gauge className="size-4 text-primary" /> Answer quality
            </h3>
            <p className="text-xs text-muted-foreground">
              Scored in the background by an LLM judge{data ? ` · ${data.evaluated} answer${data.evaluated === 1 ? '' : 's'} evaluated` : ''}
            </p>
          </div>
          <div className="w-32">
            <Select aria-label="Period" value={String(days)} onChange={(event) => setDays(Number(event.target.value))}>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </Select>
          </div>
        </div>

        {quality.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-primary" />
        ) : quality.error || !data ? (
          <p className="text-center text-sm text-destructive">{errorMessage(quality.error)}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {METRICS.map((metric) => (
                <div key={metric.key} className={cn('rounded-xl border p-4', scoreTone(data.averages[metric.key]))}>
                  <p className="font-mono text-[11px]">{metric.label}</p>
                  <p className="mt-1 font-display text-2xl font-bold">{formatScore(data.averages[metric.key])}</p>
                  <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{metric.description}</p>
                </div>
              ))}
            </div>

            {data.trend.length > 0 && (
              <div className="rounded-xl border border-border/70 bg-card/50 p-4">
                <h4 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">Daily trend</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="font-mono text-[10px] text-muted-foreground">
                      <tr>
                        <th className="pb-2 font-normal">Day</th>
                        <th className="pb-2 font-normal">Answers</th>
                        <th className="w-1/4 pb-2 font-normal">Faithfulness</th>
                        <th className="w-1/4 pb-2 font-normal">Relevance</th>
                        <th className="w-1/4 pb-2 font-normal">Precision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.trend.map((point) => (
                        <tr key={point.day}>
                          <td className="py-1.5 pr-3 font-mono text-[11px]">{point.day}</td>
                          <td className="py-1.5 pr-3 font-mono text-[11px] text-muted-foreground">{point.count}</td>
                          <td className="py-1.5 pr-3">
                            <Bar value={point.faithfulness} />
                          </td>
                          <td className="py-1.5 pr-3">
                            <Bar value={point.answerRelevance} />
                          </td>
                          <td className="py-1.5">
                            <Bar value={point.contextPrecision} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-border/70 bg-card/50 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h4 className="flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <MessageSquareQuote className="size-3.5 text-primary" /> Reader feedback
                </h4>
                <div className="flex items-center gap-3 text-xs">
                  <span className="flex items-center gap-1 text-success">
                    <ThumbsUp className="size-3.5" /> {data.feedback.positive}
                  </span>
                  <span className="flex items-center gap-1 text-destructive">
                    <ThumbsDown className="size-3.5" /> {data.feedback.negative}
                  </span>
                  {data.feedback.positive + data.feedback.negative > 0 && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                      {Math.round((data.feedback.positive / (data.feedback.positive + data.feedback.negative)) * 100)}% helpful
                    </span>
                  )}
                </div>
              </div>
              {data.feedback.recent.length === 0 ? (
                <p className="py-2 text-center text-xs text-muted-foreground">No ratings yet — use 👍 / 👎 under any answer.</p>
              ) : (
                <ul className="space-y-2">
                  {data.feedback.recent.slice(0, 8).map((item) => (
                    <li key={`${item.messageId}-${item.createdAt}`} className="flex gap-2.5 rounded-lg border border-border/50 bg-secondary/20 p-2.5 text-xs">
                      {item.rating === 1 ? <ThumbsUp className="mt-0.5 size-3.5 shrink-0 text-success" /> : <ThumbsDown className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{item.question ?? 'Answer'}</p>
                        {item.comment && <p className="mt-0.5 text-muted-foreground">“{item.comment}”</p>}
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {item.userEmail ? `${item.userEmail} · ` : ''}
                          {timeAgo(item.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-border/70 bg-card/50 p-4">
              <h4 className="mb-1 flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <AlertTriangle className="size-3.5 text-warning" /> Answers to review
              </h4>
              <p className="mb-3 text-[11px] text-muted-foreground">
                Faithfulness or relevance below 50% — possible hallucinations or off-topic answers{role === 'admin' ? ' (everyone in the workspace)' : ' (your answers)'}.
              </p>
              {data.flagged.length === 0 ? (
                <p className="py-3 text-center text-xs text-muted-foreground">Nothing flagged.</p>
              ) : (
                <ul className="space-y-2">
                  {data.flagged.map((item) => (
                    <li key={item.id} className="rounded-lg border border-border/50 bg-secondary/20 p-2.5">
                      <p className="text-xs font-medium">{item.question}</p>
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                        <ScoreChips scores={item.scores} />
                        <span className="font-mono text-[10px] text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
          <div>
            <h3 className="flex items-center gap-2 font-display text-base font-semibold">
              <FlaskConical className="size-4 text-primary" /> Benchmarks
            </h3>
            <p className="text-xs text-muted-foreground">Questions with reference answers, run through the live pipeline — the only way to measure context recall.</p>
          </div>
          {canManage && (
            <Button type="button" size="sm" onClick={startRun} disabled={busy === 'run' || runActive || caseList.length === 0}>
              {busy === 'run' || runActive ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Play className="mr-2 size-3.5" />}
              {runActive ? 'Running…' : 'Run benchmark'}
            </Button>
          )}
        </div>

        {runList.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border/70 bg-card/50 p-4">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border/60 font-mono text-[10px] text-muted-foreground">
                <tr>
                  <th className="pb-2 font-normal">Started</th>
                  <th className="pb-2 font-normal">Status</th>
                  <th className="pb-2 font-normal">Progress</th>
                  <th className="pb-2 font-normal">Scores</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {runList.map((entry) => (
                  <tr key={entry.id}>
                    <td className="py-2 pr-3 font-mono text-[11px]">{new Date(entry.createdAt).toLocaleString()}</td>
                    <td className="py-2 pr-3">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {entry.status}
                      </Badge>
                      {entry.error && (
                        <p className="mt-1 max-w-[220px] truncate text-[10px] text-destructive" title={entry.error}>
                          {entry.error}
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-muted-foreground">
                      {entry.completedCount} / {entry.caseCount}
                    </td>
                    <td className="py-2">
                      <ScoreChips scores={entry.averages} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Questions ({caseList.length}/{LIMITS.evalCasesPerWorkspace})
            </p>
            {cases.isLoading ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : caseList.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
                No benchmark questions yet{canManage ? ' — add a few questions whose correct answers you know.' : '.'}
              </p>
            ) : (
              <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
                {caseList.map((item) => (
                  <li key={item.id} className="group rounded-lg border border-border/50 bg-secondary/20 p-2.5 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium">{item.question}</p>
                      {canManage && (
                        <button
                          type="button"
                          aria-label="Delete question"
                          disabled={busy === `delete:${item.id}`}
                          onClick={() => deleteCase(item.id)}
                          className="shrink-0 rounded p-1 text-muted-foreground opacity-60 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-muted-foreground">{item.referenceAnswer}</p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">{notebookName(item.collectionId)}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {canManage && (
            <form onSubmit={addCase} className="space-y-2.5 rounded-xl border border-border/60 bg-secondary/20 p-4">
              <p className="text-xs font-medium">Add a benchmark question</p>
              <div className="space-y-1.5">
                <Label htmlFor="eval-question">Question</Label>
                <Input id="eval-question" value={question} maxLength={LIMITS.evalQuestionChars} onChange={(event) => setQuestion(event.target.value)} className="h-9 text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="eval-reference">Reference answer</Label>
                <Textarea
                  id="eval-reference"
                  rows={3}
                  value={reference}
                  maxLength={LIMITS.evalReferenceChars}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="What a correct answer must contain"
                  className="text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="eval-notebook">Search in</Label>
                <Select id="eval-notebook" value={caseNotebook} onChange={(event) => setCaseNotebook(event.target.value)}>
                  <option value="">All notebooks</option>
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" size="sm" className="w-full" disabled={busy === 'case' || !question.trim() || !reference.trim()}>
                {busy === 'case' ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
                Add question
              </Button>
            </form>
          )}
        </div>
      </section>
    </div>
  )
}
