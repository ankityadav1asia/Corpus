import { LIMITS } from '@/lib/constants'
import type { DocumentSummary, IngestResult, MediaKind, SourceType } from '@/lib/contracts'
import { notify } from '@/server/activity'
import { AiProviderError, type AiProvider } from '@/server/ai/provider'
import { Errors } from '@/server/http/errors'
import { normalizeExtractedText, truncateTitle } from '@/server/ingestion/text'
import { log } from '@/server/logger'
import { splitText } from '@/server/rag/text-splitter'
import type { Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'

export const CHUNK_SIZE = 1000
export const CHUNK_OVERLAP = 150
/** Passages embedded (one request) and stored per step of a background indexing job. */
const EMBED_STEP = 100

export interface IngestDeps {
  repos: Pick<Repositories, 'collections' | 'documents'>
  ai: AiProvider
}

export interface IngestInput {
  workspaceId: string
  collectionId: string
  /** User who added the source (kept for audit; not an access boundary). */
  createdBy: string
  sourceType: SourceType
  source: string
  title: string
  text: string
  /** Replace older documents with the same source in the same notebook (URLs, files, videos). */
  replaceExisting?: boolean
  /** Size of the uploaded file, for display. */
  byteSize?: number | null
  /** Set for documents imported by a connector (incremental sync). */
  connectorSourceId?: string | null
  externalId?: string | null
  externalVersion?: string | null
}

const split = (text: string) => splitText(text, { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP })

/** Checks everything that can be checked before anything is stored or embedded (no AI spend on bad input). */
async function validate(repos: Pick<Repositories, 'collections'>, input: IngestInput): Promise<{ text: string; pieces: string[] }> {
  if (!(await repos.collections.get(input.workspaceId, input.collectionId, input.createdBy))) throw Errors.notFound('Notebook')
  return planText(input.text)
}

/** Normalises text and splits it into passages within the per-document limits (throws AppError otherwise). */
export function planText(raw: string): { text: string; pieces: string[] } {
  const text = normalizeExtractedText(raw)
  if (!text) throw Errors.unprocessable('There is no readable text to index.')
  if (text.length > LIMITS.documentChars) {
    throw Errors.payloadTooLarge(`A document can contain at most ${LIMITS.documentChars.toLocaleString('en-US')} characters of text.`)
  }
  const pieces = split(text)
  if (pieces.length === 0) throw Errors.unprocessable('There is no readable text to index.')
  if (pieces.length > LIMITS.chunksPerDocument) {
    throw Errors.payloadTooLarge(`This document is too large to index (${pieces.length} chunks; limit ${LIMITS.chunksPerDocument}).`)
  }
  return { text, pieces }
}

function newDocument(input: Omit<IngestInput, 'text'>, totalChunks: number | null) {
  return {
    workspaceId: input.workspaceId,
    collectionId: input.collectionId,
    createdBy: input.createdBy,
    sourceType: input.sourceType,
    source: input.source.slice(0, LIMITS.urlChars),
    title: truncateTitle(input.title) || 'Untitled',
    totalChunks,
    byteSize: input.byteSize ?? null,
    connectorSourceId: input.connectorSourceId ?? null,
    externalId: input.externalId ?? null,
    externalVersion: input.externalVersion ?? null,
  }
}

/**
 * chunk → embed → store in this call (scripts and tests), with no partial state:
 * the document stays 'processing' (invisible to search) until every chunk is stored,
 * and is removed again if anything fails. The app itself uses queueDocument.
 */
export async function ingestDocument(deps: IngestDeps, input: IngestInput, signal?: AbortSignal): Promise<IngestResult> {
  const { text, pieces } = await validate(deps.repos, input)
  const document = await deps.repos.documents.createProcessing(newDocument(input, pieces.length))

  try {
    const vectors = await deps.ai.embedDocuments(pieces, signal)
    if (vectors.length !== pieces.length) throw new AiProviderError('Embedding count mismatch')
    await deps.repos.documents.insertChunks(
      { id: document.id, workspaceId: input.workspaceId, collectionId: input.collectionId },
      pieces.map((content, index) => ({ content, embedding: vectors[index]! })),
      0,
      deps.ai.embeddingModel,
    )
    const ready = await deps.repos.documents.markReady(document.id, pieces.length, text.length)
    const replacedDocuments = input.replaceExisting ? await deps.repos.documents.deleteOtherVersions(input.workspaceId, ready) : 0
    return { document: ready, replacedDocuments }
  } catch (error) {
    await deps.repos.documents
      .delete(input.workspaceId, document.id)
      .catch((cleanupError) => log.error('Could not remove partially ingested document', cleanupError, { documentId: document.id }))
    if (error instanceof AiProviderError) {
      log.error('Embedding failed during ingestion', error, { documentId: document.id })
      throw Errors.upstream('The embedding service failed. Please try again in a moment.')
    }
    throw error
  }
}

/**
 * Stores the source as a 'processing' document with its text and queues indexing, so large files
 * never hit a request timeout and rate-limited embedding calls are retried in the background.
 */
export async function queueDocument(repos: Pick<Repositories, 'collections' | 'documents' | 'jobs'>, input: IngestInput): Promise<DocumentSummary> {
  const { text, pieces } = await validate(repos, input)
  const document = await repos.documents.createQueued(newDocument(input, pieces.length), text, input.replaceExisting ?? false)
  await repos.jobs.enqueue('ingest_document', { documentId: document.id }, { maxAttempts: JOB_ATTEMPTS.ingest_document })
  return document
}

/** Shown on a media source until the background job starts reading it. */
const WAITING: Record<MediaKind, string> = {
  image: 'Waiting to read the image',
  scan: 'Waiting to read the scanned pages',
  audio: 'Waiting to transcribe the audio',
  video: 'Waiting to transcribe the video',
}

export interface MediaUpload {
  kind: MediaKind
  mimeType: string
  fileName: string
  data: Uint8Array
  /** Scanned PDFs: total pages and the pages whose text layer is already usable. */
  pageCount: number | null
  pages: ReadonlyArray<{ page: number; text: string }>
}

/**
 * Stores media (image, audio, video, scanned PDF) as a 'processing' document and queues the job that
 * reads it (OCR / vision / transcription); indexing follows automatically.
 */
/**
 * Keeps an uploaded PDF so it can be viewed with the cited passage highlighted. Optional: a failure
 * is logged and never fails the upload (the text is what answers use).
 */
export async function keepOriginalPdf(repos: Pick<Repositories, 'media'>, documentId: string, fileName: string, data: Uint8Array): Promise<void> {
  const isPdf = data.byteLength > 5 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46 && data[4] === 0x2d
  if (!isPdf) return
  try {
    await repos.media.storeFile(documentId, { mimeType: 'application/pdf', fileName, data })
  } catch (error) {
    log.warn('Could not keep the original PDF', { documentId, error: String(error) })
  }
}

export async function queueMedia(repos: Pick<Repositories, 'collections' | 'media' | 'jobs'>, input: Omit<IngestInput, 'text'>, media: MediaUpload): Promise<DocumentSummary> {
  if (!(await repos.collections.get(input.workspaceId, input.collectionId, input.createdBy))) throw Errors.notFound('Notebook')
  const document = await repos.media.createQueued(newDocument(input, null), {
    ...media,
    replaceExisting: input.replaceExisting ?? false,
    progress: WAITING[media.kind],
  })
  await repos.jobs.enqueue('read_media', { documentId: document.id }, { maxAttempts: JOB_ATTEMPTS.read_media })
  return document
}

export interface IndexingDeps {
  repos: Pick<Repositories, 'documents' | 'notifications'>
  ai: AiProvider
}

/**
 * Background indexing. Embeds and stores the remaining passages step by step; chunks already stored
 * by an earlier, interrupted run are kept (splitting is deterministic), so retries resume instead
 * of starting over. Returns 'more' at `deadline` so the job can continue in a fresh run.
 */
export async function indexQueuedDocument(deps: IndexingDeps, documentId: string, deadline: number): Promise<'done' | 'more' | 'missing'> {
  const pending = await deps.repos.documents.pendingIngest(documentId)
  if (!pending) return 'missing' // deleted, or already indexed by another run
  const pieces = split(pending.text)
  const target = { id: pending.id, workspaceId: pending.workspaceId, collectionId: pending.collectionId }

  let stored = pending.storedChunks
  while (stored < pieces.length) {
    if (Date.now() > deadline) return 'more'
    const batch = pieces.slice(stored, stored + EMBED_STEP)
    const vectors = await deps.ai.embedDocuments(batch)
    if (vectors.length !== batch.length) throw new AiProviderError('Embedding count mismatch')
    await deps.repos.documents.insertChunks(
      target,
      batch.map((content, index) => ({ content, embedding: vectors[index]! })),
      stored,
      deps.ai.embeddingModel,
    )
    stored += batch.length
    await deps.repos.documents.setIndexedCount(pending.id, stored)
  }

  const ready = await deps.repos.documents.markReady(pending.id, pieces.length, pending.text.length)
  if (pending.replaceExisting) await deps.repos.documents.deleteOtherVersions(pending.workspaceId, ready)
  // Connector imports are reported once per sync, not once per file.
  if (pending.createdBy && !pending.fromConnector) {
    await notify(deps.repos, {
      userId: pending.createdBy,
      workspaceId: pending.workspaceId,
      kind: 'document_ready',
      title: `“${ready.title}” is ready`,
      body: `${ready.chunkCount} passage${ready.chunkCount === 1 ? '' : 's'} indexed and searchable.`,
      link: { tab: 'sources', id: ready.id },
    })
  }
  return 'done'
}
