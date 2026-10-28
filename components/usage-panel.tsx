'use client'

import { Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { useUsage } from '@/hooks/use-api'
import { errorMessage } from '@/lib/api-client'
import type { TokenCount, UsageSummary } from '@/lib/contracts'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

/** What the metered calls served: job types and API areas, in words. */
const FEATURE_LABELS: Record<string, string> = {
  chat: 'Answering questions',
  followups: 'Follow-up suggestions',
  evaluate_answer: 'Answer quality checks',
  run_benchmark: 'Benchmark runs',
  ingest_document: 'Indexing sources',
  read_media: 'Reading scans, images and recordings',
  reembed_workspace: 'Re-embedding',
  sync_connector: 'Connector syncs',
  generate_report: 'Reports',
  generate_mindmap: 'Mind maps',
  generate_audio: 'Audio overviews',
  generate_image: 'Images',
  answer_bot_message: 'Slack answers',
  corpus: 'Chunk editor',
  learn: 'Adding sources',
}

const PERIODS = [7, 30, 90] as const

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat('en')
const tokens = (count: TokenCount) => count.inputTokens + count.outputTokens

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-border/70 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  )
}

const CHART = { width: 720, height: 160, top: 8, bottom: 22 }

/** Tokens per day: one series, so no legend; hovering a day shows its numbers. */
function DailyTokens({ daily }: { daily: UsageSummary['daily'] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const max = Math.max(1, ...daily.map((day) => day.inputTokens + day.outputTokens))
  const slot = CHART.width / daily.length
  const bar = Math.max(1, slot - 2) // a 2px gap between bars
  const plot = CHART.height - CHART.top - CHART.bottom
  const day = hovered === null ? null : daily[hovered]
  const shortDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const ticks = [0, Math.floor((daily.length - 1) / 2), daily.length - 1]

  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} className="h-40 w-full" role="img" aria-label={`Tokens per day over the last ${daily.length} days, at most ${whole.format(max)}`} onMouseLeave={() => setHovered(null)}>
        <line x1={0} x2={CHART.width} y1={CHART.top + plot} y2={CHART.top + plot} className="stroke-border" strokeWidth={1} />
        {daily.map((entry, index) => {
          const total = entry.inputTokens + entry.outputTokens
          const height = total === 0 ? 0 : Math.max(2, (total / max) * plot)
          const x = index * slot + 1
          const y = CHART.top + plot - height
          const radius = Math.min(4, bar / 2, height)
          return (
            <g key={entry.date} onMouseEnter={() => setHovered(index)}>
              {/* The hit target is the whole column, wider and taller than the bar. */}
              <rect x={index * slot} y={0} width={slot} height={CHART.top + plot} fill="transparent" />
              {height > 0 && (
                <path
                  d={`M${x},${y + height} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + bar - radius} Q${x + bar},${y} ${x + bar},${y + radius} V${y + height} Z`}
                  className={cn('fill-primary transition-opacity motion-reduce:transition-none', hovered !== null && hovered !== index && 'opacity-40')}
                />
              )}
            </g>
          )
        })}
        {ticks.map((index) => (
          <text
            key={index}
            x={index * slot + slot / 2}
            y={CHART.height - 6}
            textAnchor={index === 0 ? 'start' : index === daily.length - 1 ? 'end' : 'middle'}
            className="fill-muted-foreground text-[11px]"
          >
            {shortDate(daily[index]!.date)}
          </text>
        ))}
      </svg>
      {day && hovered !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-44 -translate-x-1/2 rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md"
          style={{ left: `${Math.min(88, Math.max(12, ((hovered + 0.5) / daily.length) * 100))}%` }}
        >
          <p className="font-medium">{shortDate(day.date)}</p>
          <p className="tabular-nums">{whole.format(day.inputTokens)} tokens in</p>
          <p className="tabular-nums">{whole.format(day.outputTokens)} tokens out</p>
          <p className="tabular-nums text-muted-foreground">
            {day.questions} question{day.questions === 1 ? '' : 's'}
          </p>
        </div>
      )}
      <table className="sr-only">
        <caption>Tokens and questions per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Tokens in</th>
            <th>Tokens out</th>
            <th>Questions</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((entry) => (
            <tr key={entry.date}>
              <td>{entry.date}</td>
              <td>{entry.inputTokens}</td>
              <td>{entry.outputTokens}</td>
              <td>{entry.questions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

/** A table of token use by one dimension, with an inline bar of each row's share. */
function Breakdown<T extends TokenCount>({ title, rows, name, empty }: { title: string; rows: T[]; name: (row: T) => string; empty: string }) {
  const largest = Math.max(1, ...rows.map(tokens))
  return (
    <section>
      <h4 className="mb-2 text-sm font-medium">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border/60">
              <th className="pb-1.5 font-normal">Name</th>
              <th className="pb-1.5 text-right font-normal">Calls</th>
              <th className="pb-1.5 text-right font-normal">Tokens in</th>
              <th className="pb-1.5 text-right font-normal">Tokens out</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {rows.map((row) => (
              <tr key={name(row)}>
                <td className="py-1.5 pr-3">
                  <span className="block truncate">{name(row)}</span>
                  <span className="mt-1 block h-1 rounded-full bg-primary" style={{ width: `${Math.max(2, (tokens(row) / largest) * 100)}%` }} aria-hidden />
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {whole.format(row.calls)}
                  {row.estimatedCalls > 0 && <span className="text-muted-foreground" title={`${row.estimatedCalls} estimated from the text`}>*</span>}
                </td>
                <td className="py-1.5 text-right tabular-nums">{compact.format(row.inputTokens)}</td>
                <td className="py-1.5 text-right tabular-nums">{compact.format(row.outputTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** Workspace usage for admins: AI tokens by day, feature, model and member; questions; storage. */
export function UsagePanel() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30)
  const usage = useUsage(days)
  const data = usage.data

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border/70 p-4" aria-labelledby="usage-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="usage-heading" className="text-base font-semibold">
            AI usage
          </h3>
          <p className="text-xs text-muted-foreground">Tokens the models used for this workspace, and what they were for</p>
        </div>
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Period" className="flex rounded-lg border border-border/70 p-0.5 text-xs">
            {PERIODS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={days === value}
                onClick={() => setDays(value)}
                className={cn('rounded-md px-2.5 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring', days === value ? 'bg-secondary font-medium' : 'text-muted-foreground hover:text-foreground')}
              >
                {value} days
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => usage.mutate()}
            className="flex items-center gap-1.5 rounded-lg border border-border/70 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <RefreshCw className={usage.isValidating ? 'size-3 animate-spin' : 'size-3'} aria-hidden />
            Refresh
          </button>
        </div>
      </div>

      {usage.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-primary" aria-label="Loading usage" />
        </div>
      ) : usage.error || !data ? (
        <p className="py-8 text-center text-sm text-destructive">{errorMessage(usage.error)}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Tokens in" value={compact.format(data.totals.inputTokens)} note="prompts, sources and history" />
            <Stat label="Tokens out" value={compact.format(data.totals.outputTokens)} note="answers, including thinking" />
            <Stat
              label="Model calls"
              value={whole.format(data.totals.calls)}
              note={data.totals.estimatedCalls ? `${whole.format(data.totals.estimatedCalls)} estimated from the text` : `by ${data.totals.activeMembers} member${data.totals.activeMembers === 1 ? '' : 's'}`}
            />
            <Stat label="Questions" value={whole.format(data.totals.questions)} note={`${data.totals.failedAnswers} failed`} />
          </div>

          <DailyTokens daily={data.daily} />

          <div className="grid gap-6 lg:grid-cols-2">
            <Breakdown title="By feature" rows={data.byFeature} name={(row) => FEATURE_LABELS[row.feature] ?? row.feature} empty="No model calls in this period." />
            <Breakdown title="By model" rows={data.byModel} name={(row) => `${row.model}${row.kind === 'embed' ? ' (embeddings)' : ''}`} empty="No model calls in this period." />
            <Breakdown title="By member" rows={data.byMember} name={(row) => row.email ?? (row.userId ? 'Former member' : 'Background work')} empty="No model calls in this period." />
            <section>
              <h4 className="mb-2 text-sm font-medium">Stored</h4>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <dt className="text-muted-foreground">Notebooks</dt>
                <dd className="text-right tabular-nums">{whole.format(data.storage.notebooks)}</dd>
                <dt className="text-muted-foreground">Sources</dt>
                <dd className="text-right tabular-nums">{whole.format(data.storage.documents)}</dd>
                <dt className="text-muted-foreground">Passages</dt>
                <dd className="text-right tabular-nums">{whole.format(data.storage.chunks)}</dd>
                <dt className="text-muted-foreground">Uploaded files</dt>
                <dd className="text-right tabular-nums">{formatBytes(data.storage.bytes)}</dd>
                <dt className="text-muted-foreground">Reports, mind maps, audio</dt>
                <dd className="text-right tabular-nums">
                  {data.studio.reports} / {data.studio.mindMaps} / {data.studio.audio}
                </dd>
              </dl>
            </section>
          </div>
          {data.totals.estimatedCalls > 0 && (
            <p className="text-xs text-muted-foreground">* Some calls were estimated at about four characters per token, because the model API does not count them (Gemini embeddings, some open-model servers).</p>
          )}
        </>
      )}
    </section>
  )
}
