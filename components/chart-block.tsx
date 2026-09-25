'use client'

import { BarChart3 } from 'lucide-react'
import { useState } from 'react'

import { axisUnit, formatChartValue, niceScale, type ChartSpec } from '@/lib/chart'
import { cn } from '@/lib/utils'

/** Theme-aware series colours (chart-1…5 tokens fall back to brand hues). */
const COLORS = ['hsl(var(--brand-1))', 'hsl(var(--brand-3))', 'hsl(var(--brand-2))', 'hsl(160 70% 45%)', 'hsl(35 95% 55%)', 'hsl(0 75% 60%)']

const WIDTH = 640
const HEIGHT = 280
const PAD = { top: 16, right: 16, bottom: 56 }

function Legend({ chart }: { chart: ChartSpec }) {
  const names = chart.type === 'pie' ? chart.labels : chart.series.map((series) => series.name)
  if (chart.type !== 'pie' && (names.length < 2 || names.every((name) => !name))) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {names.map((name, index) => (
        <li key={`${name}-${index}`} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: COLORS[index % COLORS.length] }} />
          {name}
        </li>
      ))}
    </ul>
  )
}

function CartesianChart({ chart }: { chart: ChartSpec }) {
  const values = chart.series.flatMap((series) => series.data).filter((value): value is number => value !== null)
  const scale = niceScale(Math.min(...values), Math.max(...values))
  const ticks: number[] = []
  for (let tick = scale.min; tick <= scale.max + scale.step / 2; tick += scale.step) ticks.push(tick)
  // Long units ("crore rupees") go under the title; ticks keep only short ones (%, $, ₹).
  const tickUnit = axisUnit(chart.unit)
  const tickLabels = ticks.map((tick) => formatChartValue(tick, tickUnit))
  const left = Math.max(36, Math.ceil(Math.max(...tickLabels.map((label) => label.length)) * 6.5) + 14)
  const plotWidth = WIDTH - left - PAD.right
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const y = (value: number) => PAD.top + plotHeight - ((value - scale.min) / (scale.max - scale.min)) * plotHeight
  const band = plotWidth / chart.labels.length
  const rotate = chart.labels.some((label) => label.length > 8) && chart.labels.length > 4

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label={chart.title ?? 'Chart'}>
      {ticks.map((tick, index) => (
        <g key={tick}>
          <line x1={left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeDasharray={tick === 0 ? undefined : '3 4'} />
          <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px]">
            {tickLabels[index]}
          </text>
        </g>
      ))}
      {chart.labels.map((label, index) => {
        const x = left + band * index + band / 2
        return (
          <text
            key={`${label}-${index}`}
            x={x}
            y={HEIGHT - PAD.bottom + 16}
            textAnchor={rotate ? 'end' : 'middle'}
            transform={rotate ? `rotate(-30 ${x} ${HEIGHT - PAD.bottom + 16})` : undefined}
            className="fill-muted-foreground text-[10px]"
          >
            {label.length > 16 ? `${label.slice(0, 15)}…` : label}
          </text>
        )
      })}
      {chart.type === 'bar'
        ? chart.series.map((series, s) => {
            const barWidth = Math.min(40, (band * 0.72) / chart.series.length)
            const groupStart = (band - barWidth * chart.series.length) / 2
            return series.data.map((value, index) => {
              if (value === null) return null
              const top = y(Math.max(value, 0))
              const height = Math.max(1, Math.abs(y(value) - y(0)))
              return (
                <rect
                  key={`${s}-${index}`}
                  x={left + band * index + groupStart + barWidth * s}
                  y={top}
                  width={barWidth - 2}
                  height={height}
                  rx={3}
                  fill={COLORS[s % COLORS.length]}
                  className="transition-opacity hover:opacity-80"
                >
                  <title>{`${series.name ? `${series.name} · ` : ''}${chart.labels[index]}: ${formatChartValue(value, chart.unit)}`}</title>
                </rect>
              )
            })
          })
        : chart.series.map((series, s) => {
            const points = series.data.map((value, index) => (value === null ? null : ([left + band * index + band / 2, y(value)] as const)))
            const path = points
              .reduce<string[]>((parts, point, index) => {
                if (!point) return parts
                parts.push(`${index === 0 || !points[index - 1] ? 'M' : 'L'}${point[0].toFixed(1)},${point[1].toFixed(1)}`)
                return parts
              }, [])
              .join(' ')
            const color = COLORS[s % COLORS.length]
            return (
              <g key={s}>
                <path d={path} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
                {points.map((point, index) =>
                  point ? (
                    <circle key={index} cx={point[0]} cy={point[1]} r={3.5} fill={color}>
                      <title>{`${series.name ? `${series.name} · ` : ''}${chart.labels[index]}: ${formatChartValue(series.data[index]!, chart.unit)}`}</title>
                    </circle>
                  ) : null,
                )}
              </g>
            )
          })}
    </svg>
  )
}

function PieChart({ chart }: { chart: ChartSpec }) {
  const data = chart.series[0]!.data.map((value) => (value !== null && value > 0 ? value : 0))
  const total = data.reduce((sum, value) => sum + value, 0) || 1
  const radius = 100
  let angle = -Math.PI / 2
  return (
    <svg viewBox="-120 -120 240 240" className="mx-auto h-auto w-full max-w-[260px]" role="img" aria-label={chart.title ?? 'Chart'}>
      {data.map((value, index) => {
        if (value === 0) return null
        const sweep = (value / total) * Math.PI * 2
        const start = angle
        angle += sweep
        const label = `${chart.labels[index]}: ${formatChartValue(value, chart.unit)} (${Math.round((value / total) * 100)}%)`
        if (sweep >= Math.PI * 2 - 1e-6) {
          return (
            <circle key={index} r={radius} fill={COLORS[index % COLORS.length]}>
              <title>{label}</title>
            </circle>
          )
        }
        const large = sweep > Math.PI ? 1 : 0
        const d = `M0,0 L${radius * Math.cos(start)},${radius * Math.sin(start)} A${radius},${radius} 0 ${large} 1 ${radius * Math.cos(angle)},${radius * Math.sin(angle)} Z`
        return (
          <path key={index} d={d} fill={COLORS[index % COLORS.length]} className="stroke-card transition-opacity hover:opacity-80" strokeWidth={2}>
            <title>{label}</title>
          </path>
        )
      })}
      <circle r={46} className="fill-card" />
    </svg>
  )
}

/** Draws a validated chart spec (bar, line or pie) with an optional data table. */
export function ChartBlock({ chart }: { chart: ChartSpec }) {
  const [showTable, setShowTable] = useState(false)
  return (
    <figure className="not-prose my-4 rounded-xl border border-border/70 bg-card/60 p-4">
      <figcaption className="mb-3 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <BarChart3 className="size-4 text-primary" />
          {chart.title ?? 'Chart'}
        </span>
        <button type="button" onClick={() => setShowTable((value) => !value)} className="text-[11px] text-muted-foreground hover:text-foreground">
          {showTable ? 'Hide data' : 'Show data'}
        </button>
      </figcaption>
      {chart.unit && chart.type !== 'pie' && !axisUnit(chart.unit) && <p className="-mt-2 mb-2 text-[11px] text-muted-foreground">Values in {chart.unit}</p>}
      {chart.type === 'pie' ? <PieChart chart={chart} /> : <CartesianChart chart={chart} />}
      <Legend chart={chart} />
      {showTable && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1 pr-3 font-medium" />
                {chart.series.map((series, index) => (
                  <th key={index} className="py-1 pr-3 font-medium">
                    {series.name || 'Value'}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.labels.map((label, row) => (
                <tr key={`${label}-${row}`} className={cn('border-t border-border/40')}>
                  <td className="py-1 pr-3">{label}</td>
                  {chart.series.map((series, index) => (
                    <td key={index} className="py-1 pr-3 font-mono">
                      {series.data[row] === null ? '—' : formatChartValue(series.data[row]!, chart.unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  )
}
