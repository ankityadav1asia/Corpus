/** Studio outputs made from sources: reports, images, audio overviews and mind maps. */
import { z } from 'zod'

import {
  AUDIO_FORMATS,
  AUDIO_LANGUAGES,
  AUDIO_LENGTHS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_STYLES,
  LIMITS,
  REPORT_TEMPLATES,
  STUDIO_LIMITS,
  type AudioFormat,
  type AudioLanguage,
  type AudioLength,
  type ImageAspectRatio,
  type ImageStyle,
  type ReportTemplate,
} from '@/lib/constants'

import type { JobStatus } from './common'
import { id, requiredText } from './fields'

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
/** Sources for studio outputs (audio overviews, mind maps): whole notebooks and/or specific documents. */
const studioSelection = {
  collectionIds: z.array(id).max(STUDIO_LIMITS.collectionsPerItem).default([]),
  documentIds: z.array(id).max(STUDIO_LIMITS.documentsPerItem).default([]),
  focus: z.string().trim().max(STUDIO_LIMITS.focusChars).optional(),
}
const hasSources = (value: { collectionIds: string[]; documentIds: string[] }) => value.collectionIds.length + value.documentIds.length > 0

export const audioCreateSchema = z
  .object({
    ...studioSelection,
    format: z.enum(AUDIO_FORMATS).default('deep_dive'),
    length: z.enum(AUDIO_LENGTHS).default('default'),
    language: z.enum(AUDIO_LANGUAGES).default('English'),
  })
  .refine(hasSources, 'Select at least one notebook or document')
export const mindMapCreateSchema = z.object(studioSelection).refine(hasSources, 'Select at least one notebook or document')

export const imageCreateSchema = z.object({
  prompt: requiredText(LIMITS.imagePromptChars),
  style: z.enum(IMAGE_STYLES).default('illustration'),
  aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).default('1:1'),
  /** Ground the image in one notebook (null / omitted = the whole workspace). */
  collectionId: id.nullish(),
  /** Or in specific documents (then no relevance search is needed). */
  documentIds: z.array(id).max(LIMITS.documentsPerImage).default([]),
})

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

export interface ImageSource {
  documentId: string
  chunkId: string | null
  title: string
  excerpt: string
}

export interface ImageSummary {
  id: string
  prompt: string
  style: ImageStyle
  aspectRatio: ImageAspectRatio
  status: JobStatus
  progress: string | null
  title: string | null
  altText: string | null
  mimeType: string | null
  byteSize: number | null
  width: number | null
  height: number | null
  createdByEmail: string | null
  createdAt: string
  completedAt: string | null
}

export interface ImageDetail extends ImageSummary {
  collectionId: string | null
  documentIds: string[]
  /** The source-grounded prompt that was sent to the image model. */
  finalPrompt: string | null
  sources: ImageSource[]
  model: string | null
  error: string | null
}

export interface StudioSource {
  documentId: string
  title: string
  source: string
}

export interface AudioSegment {
  /** 0 = first host, 1 = second host. */
  speaker: 0 | 1
  text: string
  /** Seconds from the start. */
  start: number
  end: number
}

export interface AudioSummary {
  id: string
  title: string
  format: AudioFormat
  length: AudioLength
  language: AudioLanguage
  status: JobStatus
  progress: string | null
  durationSeconds: number | null
  createdByEmail: string | null
  createdAt: string
  completedAt: string | null
}

export interface AudioDetail extends AudioSummary {
  focus: string | null
  collectionIds: string[]
  documentIds: string[]
  transcript: AudioSegment[]
  sources: StudioSource[]
  /** Voice names of the two hosts. */
  voices: string[]
  model: string | null
  byteSize: number | null
  error: string | null
}

export interface MindMapNode {
  id: string
  label: string
  /** One or two sentences from the sources. */
  summary?: string
  /** 1-based numbers into the mind map's sources. */
  sources?: number[]
  children: MindMapNode[]
}

export interface MindMapSummary {
  id: string
  title: string
  focus: string | null
  status: JobStatus
  progress: string | null
  nodeCount: number | null
  createdByEmail: string | null
  createdAt: string
  completedAt: string | null
}

export interface MindMapDetail extends MindMapSummary {
  collectionIds: string[]
  documentIds: string[]
  root: MindMapNode | null
  sources: StudioSource[]
  model: string | null
  error: string | null
}
