import { STUDIO_LIMITS } from '@/lib/constants'
import type { StudioSource } from '@/lib/contracts'
import type { AiProvider } from '@/server/ai/provider'
import { escapeSourceText } from '@/server/rag/prompt'
import { mapWithConcurrency } from '@/server/reports/generate'
import type { Repositories } from '@/server/repositories'

/**
 * The "map" step shared by studio outputs (audio overviews, mind maps): each selected document is
 * condensed into notes by the model, three at a time, so any number of sources fits one final prompt.
 */

const DOCUMENT_CHARS = 60_000
const CONCURRENCY = 3

export interface GatheredNotes {
  sources: StudioSource[]
  notes: Array<{ title: string; notes: string }>
}

export async function gatherNotes(
  deps: { repos: Pick<Repositories, 'documents'>; ai: AiProvider },
  selection: { workspaceId: string; collectionIds: string[]; documentIds: string[] },
  system: string,
  onProgress: (done: number, total: number) => Promise<void>,
): Promise<GatheredNotes | null> {
  const documents = await deps.repos.documents.resolveReportDocuments(
    selection.workspaceId,
    { collectionIds: selection.collectionIds, documentIds: selection.documentIds },
    STUDIO_LIMITS.documentsPerItem,
  )
  if (documents.length === 0) return null
  const texts = await deps.repos.documents.documentTexts(
    selection.workspaceId,
    documents.map((document) => document.id),
    DOCUMENT_CHARS,
  )
  if (texts.length === 0) return null
  let done = 0
  await onProgress(0, texts.length)
  const notes = await mapWithConcurrency(texts, CONCURRENCY, async (document) => {
    const result = await deps.ai.complete({
      system,
      prompt: `<document title="${escapeSourceText(document.title).replace(/"/g, "'")}">\n${escapeSourceText(document.text)}\n</document>`,
    })
    done += 1
    await onProgress(done, texts.length)
    return { title: document.title, notes: result.trim() || '(no usable content)' }
  })
  return { sources: texts.map((document) => ({ documentId: document.documentId, title: document.title, source: document.source })), notes }
}

/** Plain text for display: no Markdown emphasis, headings or list markers. */
export function plainText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-•]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
