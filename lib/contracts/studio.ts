/** Studio outputs made from sources: reports. */
import { z } from 'zod'

import { LIMITS, REPORT_TEMPLATES, type ReportTemplate } from '@/lib/constants'

import type { JobStatus } from './common'
import { id } from './fields'

export const reportCreateSchema = z
  .object({
    template: z.enum(REPORT_TEMPLATES),
    title: z.string().trim().max(LIMITS.documentTitleChars).optional(),
    collectionIds: z.array(id).max(20).default([]),
    documentIds: z.array(id).max(50).default([]),
    instructions: z.string().trim().max(LIMITS.reportInstructionsChars).optional(),
    /** Slide outlines can be produced as JSON; everything else is Markdown. */
    format: z.enum(['markdown', 'json']).default('markdown'),
  })
  .refine((value) => value.collectionIds.length + value.documentIds.length > 0, 'Select at least one notebook or document')
export interface SlideOutline {
  title: string
  subtitle?: string
  slides: Array<{ title: string; bullets: string[]; notes?: string }>
}

export interface ReportSummary {
  id: string
  title: string
  template: ReportTemplate
  format: 'markdown' | 'json'
  status: JobStatus
  progress: string | null
  createdAt: string
  completedAt: string | null
  createdByEmail: string | null
}

export interface ReportDetail extends ReportSummary {
  instructions: string | null
  content: string | null
  output: SlideOutline | null
  sources: Array<{ documentId: string; title: string; source: string }>
  error: string | null
}
