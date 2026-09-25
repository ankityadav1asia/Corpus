import { z } from 'zod'

/**
 * Inline charts in answers: the model may add a ```chart fenced block with this JSON. It is model
 * output (untrusted), so it is validated and bounded before anything is drawn; invalid charts are
 * shown as plain code instead.
 */

export const CHART_LIMITS = { labels: 24, series: 6, labelChars: 40, titleChars: 120 } as const

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max * 3)
    .transform((value) => (value.length > max ? `${value.slice(0, max - 1)}…` : value))

const chartSchema = z
  .object({
    type: z.enum(['bar', 'line', 'pie']),
    title: text(CHART_LIMITS.titleChars).optional(),
    unit: z.string().trim().max(20).optional(),
    labels: z
      .array(z.union([z.string(), z.number()]).transform((value) => String(value).trim().slice(0, CHART_LIMITS.labelChars)))
      .min(1)
      .max(CHART_LIMITS.labels),
    series: z
      .array(
        z.object({
          name: text(CHART_LIMITS.labelChars).optional(),
          data: z.array(z.union([z.number(), z.string(), z.null()]).transform((value) => (value === null ? null : Number(String(value).replace(/[,%\s]/g, ''))))),
        }),
      )
      .min(1)
      .max(CHART_LIMITS.series),
  })
  .transform((chart) => ({
    ...chart,
    // Pie charts show one series; every series is cut or padded to the number of labels.
    series: (chart.type === 'pie' ? chart.series.slice(0, 1) : chart.series).map((series, index) => ({
      name: series.name ?? (chart.series.length > 1 ? `Series ${index + 1}` : ''),
      data: chart.labels.map((_, i) => {
        const value = series.data[i]
        return value === null || value === undefined || !Number.isFinite(value) ? null : value
      }),
    })),
  }))

export type ChartSpec = z.output<typeof chartSchema>

/** The chart, or null when the JSON is incomplete, invalid or has nothing to draw. */
export function parseChartSpec(source: string): ChartSpec | null {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return null
  }
  const parsed = chartSchema.safeParse(raw)
  if (!parsed.success) return null
  const chart = parsed.data
  const values = chart.series.flatMap((series) => series.data).filter((value): value is number => value !== null)
  if (values.length === 0) return null
  if (chart.type === 'pie' && values.some((value) => value < 0)) return null
  return chart
}

/** Rounded axis maximum and tick step for values up to `max` (1, 2, 2.5, 5 × 10ⁿ steps). */
export function niceScale(min: number, max: number, ticks = 4): { min: number; max: number; step: number } {
  const low = Math.min(0, min)
  const high = max <= low ? low + 1 : max
  const rough = (high - low) / ticks
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power
  return { min: Math.floor(low / step) * step, max: Math.ceil(high / step) * step, step }
}

/** A unit short enough to repeat on every axis tick (%, $, ₹, kg); longer ones are shown once. */
export function axisUnit(unit: string | undefined): string | undefined {
  return unit && unit.length <= 3 ? unit : undefined
}

export function formatChartValue(value: number, unit?: string): string {
  const abs = Math.abs(value)
  const text = abs >= 1e9 ? `${+(value / 1e9).toFixed(1)}B` : abs >= 1e6 ? `${+(value / 1e6).toFixed(1)}M` : abs >= 1e4 ? `${+(value / 1e3).toFixed(1)}K` : `${+value.toFixed(2)}`
  if (!unit) return text
  return unit === '%' ? `${text}%` : /^[$€£₹¥]$/.test(unit) ? `${unit}${text}` : `${text} ${unit}`
}
