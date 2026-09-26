import { ingestUrlSchema, type QueuedIngest } from '@/lib/contracts'
import { recordAudit } from '@/server/activity'
import { readJson } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { extractYouTubeTranscript } from '@/server/ingestion/extractors'
import { queueDocument } from '@/server/ingestion/ingest-service'
import { prepareIngest } from '@/server/ingestion/prepare'
import { processJobsAfterResponse } from '@/server/jobs/trigger'

// Fetching and extracting, then queued work runs after the response (Next.js after).
export const maxDuration = 300

export const POST = workspaceRoute(async ({ req, access }) => {
  const input = await readJson(req, ingestUrlSchema)
  const { repos } = await prepareIngest(access, input.collectionId)
  const video = await extractYouTubeTranscript(input.url)
  const document = await queueDocument(repos, {
    workspaceId: access.workspaceId,
    createdBy: access.userId,
    collectionId: input.collectionId,
    sourceType: 'youtube',
    source: video.source,
    title: video.title,
    text: video.text,
    replaceExisting: true,
  })
  await recordAudit(repos, access, 'source.added', { type: 'document', id: document.id }, { title: document.title, sourceType: 'youtube' })
  processJobsAfterResponse()
  return json<QueuedIngest>({ document }, { status: 202 })
})
