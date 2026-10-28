'use client'

import { AlertTriangle, Gauge, Loader2, MessageSquareQuote, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useState } from 'react'

import { METRICS, formatScore, scoreTone } from '@/components/quality-badges'
import { Select } from '@/components/ui/select'
import { useWorkspaceContext } from '@/components/workspace-provider'
import { useQuality } from '@/hooks/use-api'
import { errorMessage } from '@/lib/api-client'
import { timeAgo } from '@/lib/format'
import type { EvaluationScores } from '@/lib/contracts'
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
        className={cn('h-full rounded-full', value === null ? '' : value >= 0.8 ? 'bg-ok' : value >= 0.5 ? 'bg-signal' : 'bg-bad')}
        style={{ width: `${Math.round((value ?? 0) * 100)}%` }}
      />
    </div>
  )
}

/** LLM-as-judge quality of live answers and readers' thumbs up / down. */
export function QualityPanel() {
  const { role } = useWorkspaceContext()
  const [days, setDays] = useState(30)
  const quality = useQuality(days)

  const data = quality.data

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
          <div>
            <h3 className="flex items-center gap-2 font-display text-base font-medium">
              <Gauge className="size-4 text-primary" /> Answer quality
            </h3>
            <p className="text-xs text-muted-foreground">
              Scored in the background by an LLM judge{data ? `, ${data.evaluated} answer${data.evaluated === 1 ? '' : 's'} evaluated` : ''}
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
                  <p className=" text-xs">{metric.label}</p>
                  <p className="mt-1 font-display text-2xl font-medium">{formatScore(data.averages[metric.key])}</p>
                  <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{metric.description}</p>
                </div>
              ))}
            </div>

            {data.trend.length > 0 && (
              <div className="rounded-xl border border-border/70 bg-card/50 p-4">
                <h4 className="mb-3 text-xs font-medium text-muted-foreground">Daily trend</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className=" text-xs text-muted-foreground">
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
                <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
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
                <p className="py-2 text-center text-xs text-muted-foreground">No ratings yet. Rate any answer with the thumbs under it.</p>
              ) : (
                <ul className="space-y-2">
                  {data.feedback.recent.slice(0, 8).map((item) => (
                    <li key={`${item.messageId}-${item.createdAt}`} className="flex gap-2.5 rounded-lg border border-border/50 bg-secondary/20 p-2.5 text-xs">
                      {item.rating === 1 ? <ThumbsUp className="mt-0.5 size-3.5 shrink-0 text-success" /> : <ThumbsDown className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{item.question ?? 'Answer'}</p>
                        {item.comment && <p className="mt-0.5 text-muted-foreground">“{item.comment}”</p>}
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {item.userEmail ? `${item.userEmail}, ` : ''}
                          {timeAgo(item.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-border/70 bg-card/50 p-4">
              <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <AlertTriangle className="size-3.5 text-warning" /> Answers to review
              </h4>
              <p className="mb-3 text-[11px] text-muted-foreground">
                Faithfulness or relevance below 50%: possible hallucinations or off-topic answers{role === 'admin' ? ' (everyone in the workspace)' : ' (your answers)'}.
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
    </div>
  )
}
