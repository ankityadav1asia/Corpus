import type { ChunkMetadataValue, ChunkRow } from '@/lib/contracts'
import { AiProviderError, type AiProvider } from '@/server/ai/provider'
import { requireCollectionPermission, type WorkspaceAccess } from '@/server/auth/access'
import { Errors } from '@/server/http/errors'
import { normalizeExtractedText } from '@/server/ingestion/text'
import type { Repositories } from '@/server/repositories'

/**
 * Chunk-level CRUD. Text and vector live in the same Postgres row (pgvector), so an edit updates
 * both atomically: new text is re-embedded before the row is written, and the full-text index
 * (a generated column) follows automatically.
 */

export interface ChunkEditorDeps {
  repos: Pick<Repositories, 'documents' | 'chunks' | 'collections'>
  ai: () => AiProvider
}

async function embedChunk(ai: AiProvider, content: string): Promise<number[]> {
  try {
    const [vector] = await ai.embedDocuments([content])
    if (!vector) throw new AiProviderError('No embedding returned')
    return vector
  } catch (error) {
    if (error instanceof AiProviderError) throw Errors.upstream('The embedding service failed, so the chunk was not changed. Please try again.')
    throw error
  }
}

function cleanContent(value: string): string {
  const content = normalizeExtractedText(value)
  if (!content) throw Errors.unprocessable('A chunk needs some text.')
  return content
}

async function locateForEdit(deps: ChunkEditorDeps, access: WorkspaceAccess, chunkId: string) {
  const location = await deps.repos.chunks.location(access.workspaceId, chunkId)
  if (!location) throw Errors.notFound('Chunk')
  await requireCollectionPermission(deps.repos, access, location.collectionId, 'collection.editChunks')
  return location
}

export async function updateChunk(
  deps: ChunkEditorDeps,
  access: WorkspaceAccess,
  chunkId: string,
  changes: { content?: string; labels?: string[]; metadata?: Record<string, ChunkMetadataValue> },
): Promise<ChunkRow> {
  await locateForEdit(deps, access, chunkId)
  const content = changes.content === undefined ? undefined : cleanContent(changes.content)
  const ai = content === undefined ? null : deps.ai()
  const embedding = content === undefined || !ai ? undefined : await embedChunk(ai, content)
  const updated = await deps.repos.chunks.update(
    access.workspaceId,
    chunkId,
    { content, embedding, embeddingModel: ai?.embeddingModel, labels: changes.labels, metadata: changes.metadata },
    access.userId,
  )
  if (!updated) throw Errors.notFound('Chunk')
  return updated
}

export async function appendChunk(
  deps: ChunkEditorDeps,
  access: WorkspaceAccess,
  documentId: string,
  input: { content: string; labels?: string[]; metadata?: Record<string, ChunkMetadataValue> },
): Promise<ChunkRow> {
  const document = await deps.repos.documents.get(access.workspaceId, documentId)
  if (!document) throw Errors.notFound('Document')
  await requireCollectionPermission(deps.repos, access, document.collectionId, 'collection.editChunks')
  if (document.status !== 'ready') throw Errors.conflict('This document is still being indexed.')
  const content = cleanContent(input.content)
  const ai = deps.ai()
  const embedding = await embedChunk(ai, content)
  const created = await deps.repos.chunks.append(
    access.workspaceId,
    documentId,
    { content, embedding, embeddingModel: ai.embeddingModel, labels: input.labels ?? [], metadata: input.metadata ?? {} },
    access.userId,
  )
  if (!created) throw Errors.notFound('Document')
  return created
}

export async function deleteChunk(deps: ChunkEditorDeps, access: WorkspaceAccess, chunkId: string): Promise<void> {
  await locateForEdit(deps, access, chunkId)
  if (!(await deps.repos.chunks.delete(access.workspaceId, chunkId))) throw Errors.notFound('Chunk')
}
