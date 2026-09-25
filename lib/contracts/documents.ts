/** Sources (documents), ingestion and the chunk editor. */
import { z } from 'zod'

import { LIMITS } from '@/lib/constants'

import { id, requiredText } from './fields'

export const ingestTextSchema = z.object({
  collectionId: id,
  title: z.string().trim().max(LIMITS.documentTitleChars).optional(),
  // The size limit is enforced by the ingest service so it can answer 413 instead of 400.
  text: z.string().min(1),
})

export const ingestUrlSchema = z.object({
  collectionId: id,
  url: requiredText(LIMITS.urlChars),
})

export const documentsQuerySchema = z.object({ collectionId: id.optional() })

export const clearCollectionQuerySchema = z.object({ collectionId: id })

const label = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(LIMITS.labelChars)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.:-]*$/u, 'Labels may contain letters, numbers, spaces and _ . : -')

export const chunkLabelsSchema = z
  .array(label)
  .max(LIMITS.labelsPerChunk)
  .transform((labels) => [...new Set(labels)])

export type ChunkMetadataValue = string | number | boolean

export const chunkMetadataSchema = z
  .record(
    z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9_.-]+$/, 'Metadata keys may contain letters, numbers and _ . -'),
    z.union([z.string().max(LIMITS.metadataValueChars), z.number().finite(), z.boolean()]),
  )
  .refine((value) => Object.keys(value).length <= LIMITS.metadataKeysPerChunk, `At most ${LIMITS.metadataKeysPerChunk} metadata keys`)

export const chunkUpdateSchema = z
  .object({
    content: requiredText(LIMITS.chunkChars).optional(),
    labels: chunkLabelsSchema.optional(),
    metadata: chunkMetadataSchema.optional(),
  })
  .refine((value) => value.content !== undefined || value.labels !== undefined || value.metadata !== undefined, 'Nothing to update')

export const chunkCreateSchema = z.object({
  content: requiredText(LIMITS.chunkChars),
  labels: chunkLabelsSchema.optional(),
  metadata: chunkMetadataSchema.optional(),
})

export const chunksQuerySchema = z.object({
  collectionId: id.optional(),
  documentId: id.optional(),
  label: z.string().trim().toLowerCase().max(LIMITS.labelChars).optional(),
  q: z.string().trim().max(LIMITS.explorerSearchChars).optional(),
  page: z.coerce.number().int().min(0).max(10_000).default(0),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

export type SourceType = 'text' | 'file' | 'url' | 'youtube' | 'google_drive' | 'notion' | 'github' | 'website'

/** Sources that are read before indexing: images (OCR + description), audio/video (transcription), scanned PDFs (OCR). */
export type MediaKind = 'image' | 'audio' | 'video' | 'scan'
export type DocumentStatus = 'processing' | 'ready' | 'failed'

export interface DocumentSummary {
  id: string
  collectionId: string
  sourceType: SourceType
  source: string
  title: string
  status: DocumentStatus
  /** Chunks stored so far (all of them once ready). */
  chunkCount: number
  /** Chunks planned while indexing runs in the background; null for older documents. */
  totalChunks: number | null
  charCount: number
  /** Size of the uploaded file, when it came from a file. */
  byteSize: number | null
  /** Why indexing failed (status 'failed'). */
  error: string | null
  /** What is happening while it is processed ("Reading scanned pages 3/12"). */
  progress: string | null
  mediaKind: MediaKind | null
  createdAt: string
}

export interface DocumentDetail {
  document: DocumentSummary
  chunks: Array<{ id: string; chunkIndex: number; content: string; labels: string[] }>
  /** The original file, when it was kept (PDFs): viewable with the cited passage highlighted. */
  file?: { mimeType: string; fileName: string; byteSize: number } | null
}

export interface ChunkRow {
  id: string
  documentId: string
  collectionId: string
  chunkIndex: number
  content: string
  documentTitle: string
  source: string
  sourceType: SourceType
  labels: string[]
  metadata: Record<string, ChunkMetadataValue>
  updatedAt: string | null
}

export interface ChunkDetail extends ChunkRow {
  embedding: { dimensions: number; norm: number; preview: number[] }
}

export interface ChunkPage {
  items: ChunkRow[]
  total: number
  page: number
  pageSize: number
}

export interface IngestResult {
  document: DocumentSummary
  /** Older copies of the same URL / file / video that were replaced by this ingest. */
  replacedDocuments: number
}

/** Sources are indexed in the background: the document comes back with status 'processing'. */
export interface QueuedIngest {
  document: DocumentSummary
}

export interface UploadResult {
  results: Array<{ filename: string; status: 'queued' | 'error'; document?: DocumentSummary; error?: string }>
}
