import { LIMITS } from '@/lib/constants'
import { ingestTextSchema, type QueuedIngest } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { readJson } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { queueDocument } from '@/server/ingestion/ingest-service'
import { prepareIngest } from '@/server/ingestion/prepare'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { deriveTitle } from '@/server/rag/prompt'

/** Index pasted text in the background (202). Body cap covers the worst-case UTF-8 size of LIMITS.documentChars. */
export const POST = workspaceRoute(async ({ req, access }) => {
  const input = await readJson(req, ingestTextSchema, LIMITS.documentChars * 4 + 16 * 1024)
  const { repos } = await prepareIngest(access, input.collectionId)
  const document = await queueDocument(repos, {
    workspaceId: access.workspaceId,
    createdBy: access.userId,
    collectionId: input.collectionId,
    sourceType: 'text',
    source: 'pasted-text',
    title: input.title || deriveTitle(input.text),
    text: input.text,
  })
  await recordAudit(repos, access, 'source.added', { type: 'document', id: document.id }, { title: document.title, sourceType: 'text' })
  processJobsAfterResponse()
  return json<QueuedIngest>({ document }, { status: 202 })
})
