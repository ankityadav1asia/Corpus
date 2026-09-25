import type { DocumentStatus, DocumentSummary, MediaKind, SourceType } from '@/lib/contracts'
import { toIso, toNullableNumber, toNumber } from '@/server/repositories/sql'

/** Row mapping shared by the documents, chunks and media repositories. */

export interface NewDocument {
  workspaceId: string
  collectionId: string
  createdBy: string | null
  sourceType: SourceType
  source: string
  title: string
  /** Planned chunk count (shown as progress while indexing). */
  totalChunks?: number | null
  /** Size of the uploaded file. */
  byteSize?: number | null
  /** Connector sync bookkeeping (documents imported from Drive, Notion, GitHub, a website). */
  connectorSourceId?: string | null
  externalId?: string | null
  externalVersion?: string | null
}

export const DOCUMENT_COLUMNS = `id, collection_id, source_type, source, title, status, chunk_count, total_chunks, char_count, byte_size, error, progress, media_kind, created_at`

export function mapDocument(row: Record<string, unknown>): DocumentSummary {
  return {
    id: String(row.id),
    collectionId: String(row.collection_id),
    sourceType: row.source_type as SourceType,
    source: String(row.source),
    title: String(row.title),
    status: row.status as DocumentStatus,
    chunkCount: toNumber(row.chunk_count),
    totalChunks: toNullableNumber(row.total_chunks),
    charCount: toNumber(row.char_count),
    byteSize: toNullableNumber(row.byte_size),
    error: row.error ? String(row.error) : null,
    progress: row.progress ? String(row.progress) : null,
    mediaKind: row.media_kind ? (row.media_kind as MediaKind) : null,
    createdAt: toIso(row.created_at),
  }
}

export function asLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  // Some drivers return text[] in Postgres array literal form: {a,b}
  if (typeof value === 'string' && value.startsWith('{')) {
    return value
      .slice(1, -1)
      .split(',')
      .filter(Boolean)
      .map((label) => label.replace(/^"|"$/g, ''))
  }
  return []
}

export function documentValues(input: NewDocument): unknown[] {
  return [
    input.workspaceId,
    input.collectionId,
    input.createdBy,
    input.sourceType,
    input.source,
    input.title,
    input.totalChunks ?? null,
    input.byteSize ?? null,
    input.connectorSourceId ?? null,
    input.externalId ?? null,
    input.externalVersion ?? null,
  ]
}
