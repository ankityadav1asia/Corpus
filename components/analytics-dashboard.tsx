'use client'

import { Activity, AlertTriangle, Bot, Clock, Database, Layers, Loader2, RefreshCw, SearchX, Zap } from 'lucide-react'
import { useState } from 'react'

import { QualityPanel } from '@/components/quality-panel'
import { Badge } from '@/components/ui/badge'
import { useWorkspaceContext } from '@/components/workspace-provider'
import { useAnalytics } from '@/hooks/use-api'
import { errorMessage } from '@/lib/api-client'
import type { Collection, StatsResponse } from '@/lib/contracts'
import { cn } from '@/lib/utils'

function Metric({ label, value, hint, icon: Icon }: { label: string; value: string; hint: string; icon: typeof Activity }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="font-mono text-xs">{label}</span>
        <Icon className="size-4 text-primary" />
      </div>
      <p className="mt-2 font-display text-2xl font-bold text-foreground">{value}</p>
      <span className="font-mono text-[10px] text-muted-foreground">{hint}</span>
    </div>
  )
}

interface AnalyticsDashboardProps {
  totals: StatsResponse['totals'] | undefined
  collections: Collection[]
}

/** Usage and latency (your own questions, or the whole workspace for admins) plus answer quality. */
export function AnalyticsDashboard({ totals, collections }: AnalyticsDashboardProps) {
  const { role, active } = useWorkspaceContext()
  const [scope, setScope] = useState<'me' | 'workspace'>('me')
  const effectiveScope = role === 'admin' ? scope : 'me'
  const analytics = useAnalytics(effectiveScope)
  const data = analytics.data

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto pr-1">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-4">
        <div>
          <h3 className="font-display text-base font-semibold">Usage & latency</h3>
          <p className="text-xs text-muted-foreground">
            {effectiveScope === 'workspace' ? 'Everyone’s questions in this workspace' : 'Your questions'}, retrieval volume and response times
          </p>
        </div>
        <div className="flex items-center gap-2">
          {role === 'admin' && !active?.isPersonal && (
            <div role="radiogroup" aria-label="Whose questions" className="flex rounded-lg border border-border/70 bg-secondary/40 p-0.5 text-xs">
              {(['me', 'workspace'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={scope === value}
                  onClick={() => setScope(value)}
                  className={cn('rounded-md px-2.5 py-1', scope === value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                >
                  {value === 'me' ? 'Mine' : 'Workspace'}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => analytics.mutate()}
            className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-secondary/40 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={analytics.isValidating ? 'size-3 animate-spin' : 'size-3'} />
            Refresh
          </button>
        </div>
      </div>

      {analytics.isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : analytics.error || !data ? (
        <p className="py-10 text-center text-sm text-destructive">{errorMessage(analytics.error)}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Metric label="Questions" value={data.totals.queries.toLocaleString()} hint={`${data.totals.errors} failed · ${data.totals.insufficient} withheld`} icon={Activity} />
            <Metric
              label="Latency"
              value={data.totals.avgLatencyMs === null ? '—' : `${data.totals.avgLatencyMs} ms`}
              hint={data.totals.p95LatencyMs === null ? 'average' : `average · p95 ${data.totals.p95LatencyMs} ms`}
              icon={Clock}
            />
            <Metric label="Passages" value={(totals?.chunks ?? 0).toLocaleString()} hint={`${totals?.documents ?? 0} documents indexed`} icon={Database} />
            <Metric
              label="Notebooks"
              value={String(totals?.collections ?? 0)}
              hint={active?.isPersonal ? 'in your personal workspace' : `in ${active?.name ?? 'this workspace'}`}
              icon={Layers}
            />
          </div>

          <div className="flex flex-wrap gap-4 rounded-xl border border-border/70 bg-card/50 p-4">
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/40 px-3 py-2">
              <Zap className="size-4 text-amber-400" />
              <div>
                <div className="text-xs font-medium">Standard</div>
                <div className="font-mono text-[10px] text-muted-foreground">{data.byMode.standard} questions</div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/40 px-3 py-2">
              <Bot className="size-4 text-primary" />
              <div>
                <div className="text-xs font-medium">Deep (multi-query · step-back · HyDE)</div>
                <div className="font-mono text-[10px] text-muted-foreground">{data.byMode.deep} questions</div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/40 px-3 py-2">
              <SearchX className="size-4 text-amber-500" />
              <div>
                <div className="text-xs font-medium">Withheld by the guardrail</div>
                <div className="font-mono text-[10px] text-muted-foreground">{data.totals.insufficient} “insufficient context” replies</div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-card/50 p-4">
            <h4 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent questions</h4>
            {data.recent.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">No questions yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border/60 font-mono text-[11px] text-muted-foreground">
                    <tr>
                      <th className="pb-2 font-normal">Question</th>
                      <th className="pb-2 font-normal">Mode</th>
                      <th className="pb-2 font-normal">Passages</th>
                      <th className="pb-2 font-normal">Latency</th>
                      <th className="pb-2 font-normal">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {data.recent.map((entry) => (
                      <tr key={entry.id}>
                        <td className="max-w-[320px] truncate py-2.5 pr-4 font-medium" title={entry.query}>
                          {entry.status === 'error' && <AlertTriangle className="mr-1 inline size-3 text-destructive" aria-label="failed" />}
                          {entry.status === 'insufficient_context' && <SearchX className="mr-1 inline size-3 text-amber-500" aria-label="withheld: insufficient context" />}
                          {entry.query}
                        </td>
                        <td className="py-2.5">
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {entry.mode}
                          </Badge>
                        </td>
                        <td className="py-2.5 font-mono text-[11px] text-muted-foreground">{entry.chunksRetrieved}</td>
                        <td className="py-2.5 font-mono text-[11px] text-amber-500">{entry.latencyMs} ms</td>
                        <td className="py-2.5 font-mono text-[10px] text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <QualityPanel collections={collections} />
    </div>
  )
}
