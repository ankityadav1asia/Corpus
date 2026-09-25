import { ingestUrlSchema, type QueuedIngest } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { readJson } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { extractWebPage } from '@/server/ingestion/extractors'
import { queueDocument } from '@/server/ingestion/ingest-service'
import { prepareIngest } from '@/server/ingestion/prepare'
import { processJobsAfterResponse } from '@/server/jobs/trigger'

export const maxDuration = 60

/** Imports a public web page through the SSRF-guarded fetcher (server/security/ssrf.ts); indexing runs in the background. */
export const POST = workspaceRoute(async ({ req, access }) => {
  const input = await readJson(req, ingestUrlSchema)
  const { repos } = await prepareIngest(access, input.collectionId)
  const page = await extractWebPage(input.url)
  const document = await queueDocument(repos, {
    workspaceId: access.workspaceId,
    createdBy: access.userId,
    collectionId: input.collectionId,
    sourceType: 'url',
    source: page.source,
    title: page.title,
    text: page.text,
    replaceExisting: true,
  })
  await recordAudit(repos, access, 'source.added', { type: 'document', id: document.id }, { title: document.title, sourceType: 'url' })
  processJobsAfterResponse()
  return json<QueuedIngest>({ document }, { status: 202 })
})
