import { Gauge } from 'lucide-react'

import type { EvaluationScores } from '@/lib/contracts'
import { cn } from '@/lib/utils'

export const METRICS: ReadonlyArray<{ key: keyof EvaluationScores; label: string; description: string }> = [
  { key: 'faithfulness', label: 'Faithfulness', description: 'Share of the answer’s claims that the retrieved passages support (low = possible hallucination)' },
  { key: 'answerRelevance', label: 'Answer relevance', description: 'How directly the answer addresses the question' },
  { key: 'contextPrecision', label: 'Context precision', description: 'Share of the retrieved passages that were relevant to the question' },
  { key: 'contextRecall', label: 'Context recall', description: 'Share of the reference answer covered by the retrieved passages (benchmarks only)' },
]

export function formatScore(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`
}

/** Traffic-light colouring shared by chat badges and the quality dashboard. */
export function scoreTone(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'border-border/60 text-muted-foreground'
  if (value >= 0.8) return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
  if (value >= 0.5) return 'border-amber-500/40 bg-amber-500/10 text-amber-500'
  return 'border-red-500/40 bg-red-500/10 text-red-500'
}

/** Per-answer quality scores from the background judge. */
export function EvaluationBadges({ scores }: { scores: EvaluationScores }) {
  const shown = METRICS.filter((metric) => scores[metric.key] !== null)
  if (shown.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Answer quality">
      <Gauge className="size-3.5 text-muted-foreground" aria-hidden />
      {shown.map((metric) => (
        <span key={metric.key} title={metric.description} className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[10px]', scoreTone(scores[metric.key]))}>
          {metric.label} {formatScore(scores[metric.key])}
        </span>
      ))}
    </div>
  )
}
