import { idSchema, type QueuedIngest } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { parseWith } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { prepareIngest } from '@/server/ingestion/prepare'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { JOB_ATTEMPTS } from '@/server/repositories/jobs'
import { getServices } from '@/server/services'

/** Queues indexing again for a document that failed (Editor). Chunks stored before the failure are kept. */
export const POST = workspaceRoute<{ id: string }>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const existing = await getServices().repos.documents.get(access.workspaceId, id)
  if (!existing) throw Errors.notFound('Document')
  const { repos } = await prepareIngest(access, existing.collectionId)
  const document = await repos.documents.retryIngest(access.workspaceId, id)
  if (!document) throw Errors.conflict('Only documents whose indexing failed can be retried.')
  // Media that was never read (OCR / transcription failed) is read again; otherwise indexing resumes.
  const type = (await repos.media.pending(id)) ? 'read_media' : 'ingest_document'
  await repos.jobs.enqueue(type, { documentId: id }, { maxAttempts: JOB_ATTEMPTS[type] })
  await recordAudit(repos, access, 'document.retried', { type: 'document', id }, { title: document.title })
  processJobsAfterResponse()
  return json<QueuedIngest>({ document }, { status: 202 })
})
