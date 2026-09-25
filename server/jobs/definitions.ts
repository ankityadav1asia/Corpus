import { z } from 'zod'

import { notify } from '@/server/activity'
import { syncConnectorSource, syncPayload } from '@/server/connectors/sync'
import { benchmarkPayload, evaluateAnswerPayload, evaluateMessage, runBenchmarkBatch } from '@/server/evaluation/service'
import { generateImage, imagePayload } from '@/server/images/generate'
import { indexQueuedDocument } from '@/server/ingestion/ingest-service'
import { answerBotMessage, botMessagePayload } from '@/server/integrations/service'
import type { JobContext } from '@/server/jobs/context'
import { PermanentJobError } from '@/server/jobs/errors'
import { readQueuedMedia } from '@/server/media/read-media'
import { reembedPayload, reembedWorkspace } from '@/server/rag/reembed'
import { generateReport, reportPayload } from '@/server/reports/generate'
import type { Repositories } from '@/server/repositories'
import { JOB_ATTEMPTS, type JobType } from '@/server/repositories/jobs'
import type { NewNotification } from '@/server/repositories/notifications'
import { audioPayload, generateAudio } from '@/server/studio/audio'
import { generateMindMap, mindMapPayload } from '@/server/studio/mindmap'

/**
 * What each background job does: run it, say why it waits when a retry is scheduled, and — once it
 * is out of retries — record the failure where the user looks and tell the person who started it.
 */
export interface JobDefinition {
  run(payload: unknown, context: JobContext, deadline: number): Promise<void>
  onRetry(payload: unknown, context: JobContext, progress: string): Promise<void>
  onFailure(payload: unknown, context: JobContext, reason: string, error: unknown): Promise<void>
}

interface Steps<P> {
  run(payload: P, context: JobContext, deadline: number): Promise<unknown>
  /** For items that show progress text. */
  onRetry?(payload: P, context: JobContext, progress: string): Promise<void>
  onFailure?(payload: P, context: JobContext, reason: string, error: unknown): Promise<void>
}

/** Validates the payload for every step; one that no longer parses is skipped on retry and failure. */
function defineJob<P>(schema: z.ZodType<P>, steps: Steps<P>): JobDefinition {
  return {
    async run(payload, context, deadline) {
      await steps.run(schema.parse(payload), context, deadline)
    },
    async onRetry(payload, context, progress) {
      const parsed = schema.safeParse(payload)
      if (parsed.success && steps.onRetry) await steps.onRetry(parsed.data, context, progress)
    },
    async onFailure(payload, context, reason, error) {
      const parsed = schema.safeParse(payload)
      if (parsed.success && steps.onFailure) await steps.onFailure(parsed.data, context, reason, error)
    },
  }
}

/** Leaves room to store the step in progress before the time budget runs out. */
const STEP_MARGIN_MS = 15_000

const off = () => null

/** Long work continues in a fresh job rather than overrunning the time budget. */
async function continueIfMore(context: JobContext, type: JobType, payload: Record<string, unknown>, result: string) {
  if (result === 'more') await context.repos.jobs.enqueue(type, payload, { maxAttempts: JOB_ATTEMPTS[type] })
}

/** Tells the person who started the work (no one when their account has been deleted). */
async function tellCreator(
  repos: Pick<Repositories, 'notifications'>,
  item: { createdBy: string | null; workspaceId: string } | null,
  message: Omit<NewNotification, 'userId' | 'workspaceId'>,
) {
  if (item?.createdBy) await notify(repos, { ...message, userId: item.createdBy, workspaceId: item.workspaceId })
}

const ingestPayload = z.object({ documentId: z.guid() })

/** Reading media and indexing both belong to a document and fail the same way. */
function documentJob(run: Steps<z.infer<typeof ingestPayload>>['run']): JobDefinition {
  return defineJob(ingestPayload, {
    run,
    onRetry: ({ documentId }, { repos }, progress) => repos.documents.setProgress(documentId, progress),
    async onFailure({ documentId }, { repos }, reason) {
      const failed = await repos.documents.failIngest(documentId, reason)
      if (!failed) return
      await tellCreator(repos, await repos.documents.creator(documentId), {
        kind: 'document_failed',
        title: `Could not index “${failed.title}”`,
        body: `${reason} You can retry it from the sources list.`,
        link: { tab: 'sources', id: failed.id },
      })
    },
  })
}

export const JOBS: Record<JobType, JobDefinition> = {
  evaluate_answer: defineJob(evaluateAnswerPayload, {
    run: (payload, context) => evaluateMessage({ repos: context.repos, ai: context.ai(), reranker: null }, payload),
  }),

  run_benchmark: defineJob(benchmarkPayload, {
    async run(payload, context, deadline) {
      const result = await runBenchmarkBatch({ repos: context.repos, ai: context.ai(), reranker: context.reranker() }, payload, deadline)
      await continueIfMore(context, 'run_benchmark', payload, result)
    },
    async onFailure({ runId }, { repos }, reason) {
      await repos.evaluations.markRun(runId, 'failed', reason)
      await tellCreator(repos, await repos.evaluations.runForJob(runId), { kind: 'benchmark_failed', title: 'Benchmark run failed', body: reason, link: { tab: 'analytics' } })
    },
  }),

  ingest_document: documentJob(async (payload, context, deadline) => {
    const result = await indexQueuedDocument({ repos: context.repos, ai: context.ai() }, payload.documentId, deadline - STEP_MARGIN_MS)
    // Very large documents are indexed across several runs; each resumes where the last one stopped.
    await continueIfMore(context, 'ingest_document', payload, result)
  }),

  read_media: documentJob(async (payload, context, deadline) => {
    const deps = { repos: context.repos, vision: context.vision ?? off, transcriber: context.transcriber ?? off, ocr: context.ocr ?? off }
    // Long scans are read across several runs; each resumes at the first unread page.
    await continueIfMore(context, 'read_media', payload, await readQueuedMedia(deps, payload.documentId, deadline - STEP_MARGIN_MS))
  }),

  reembed_workspace: defineJob(reembedPayload, {
    async run(payload, context, deadline) {
      const result = await reembedWorkspace({ repos: context.repos, ai: context.ai() }, payload.workspaceId, deadline - STEP_MARGIN_MS)
      await continueIfMore(context, 'reembed_workspace', payload, result)
    },
  }),

  generate_report: defineJob(reportPayload, {
    run: ({ reportId }, context) => generateReport({ repos: context.repos, ai: context.ai() }, reportId),
    onRetry: ({ reportId }, { repos }, progress) => repos.reports.setProgress(reportId, 'queued', progress),
    async onFailure({ reportId }, { repos }, reason) {
      await repos.reports.fail(reportId, reason)
      const report = await repos.reports.forJob(reportId)
      if (report) await tellCreator(repos, report, { kind: 'report_failed', title: `Report failed: ${report.title}`, body: reason, link: { tab: 'reports', id: report.id } })
    },
  }),

  generate_image: defineJob(imagePayload, {
    async run({ imageId }, context) {
      const images = context.images()
      if (!images) throw new PermanentJobError('Image generation is not configured on this server.')
      await generateImage({ repos: context.repos, ai: context.ai(), reranker: context.reranker(), images }, imageId)
    },
    onRetry: ({ imageId }, { repos }, progress) => repos.images.setProgress(imageId, 'queued', progress),
    async onFailure({ imageId }, { repos }, reason) {
      const image = await repos.images.forJob(imageId)
      if (!image) return
      await repos.images.fail(image.id, reason)
      await tellCreator(repos, image, { kind: 'image_failed', title: 'An image could not be generated', body: reason, link: { tab: 'images', id: image.id } })
    },
  }),

  generate_audio: defineJob(audioPayload, {
    async run(payload, context, deadline) {
      const result = await generateAudio({ repos: context.repos, ai: context.ai(), speech: (context.speech ?? off)() }, payload.audioId, deadline - STEP_MARGIN_MS)
      // Recording continues segment by segment in fresh runs.
      await continueIfMore(context, 'generate_audio', payload, result)
    },
    onRetry: ({ audioId }, { repos }, progress) => repos.audio.setProgress(audioId, 'queued', progress),
    async onFailure({ audioId }, { repos }, reason) {
      const audio = await repos.audio.forJob(audioId)
      if (!audio) return
      await repos.audio.fail(audio.id, reason)
      await tellCreator(repos, audio, { kind: 'audio_failed', title: 'An audio overview could not be created', body: reason, link: { tab: 'audio', id: audio.id } })
    },
  }),

  generate_mindmap: defineJob(mindMapPayload, {
    run: ({ mindMapId }, context) => generateMindMap({ repos: context.repos, ai: context.ai() }, mindMapId),
    onRetry: ({ mindMapId }, { repos }, progress) => repos.mindMaps.setProgress(mindMapId, 'queued', progress),
    async onFailure({ mindMapId }, { repos }, reason) {
      const map = await repos.mindMaps.forJob(mindMapId)
      if (!map) return
      await repos.mindMaps.fail(map.id, reason)
      await tellCreator(repos, map, { kind: 'mindmap_failed', title: 'A mind map could not be created', body: reason, link: { tab: 'mindmaps', id: map.id } })
    },
  }),

  answer_bot_message: defineJob(botMessagePayload, {
    async run(payload, context) {
      if (!context.secret) throw new PermanentJobError('Chat apps are not available on this server.')
      await answerBotMessage({ repos: context.repos, ai: context.ai(), reranker: context.reranker(), fetch: context.fetch ?? fetch, secret: context.secret() }, payload)
    },
  }),

  sync_connector: defineJob(syncPayload, {
    async run(payload, context, deadline) {
      if (!context.connectors || !context.secret) throw new PermanentJobError('Connectors are not available on this server.')
      const result = await syncConnectorSource({ repos: context.repos, connectors: context.connectors(), secret: context.secret() }, payload.sourceId, deadline - STEP_MARGIN_MS)
      await continueIfMore(context, 'sync_connector', payload, result)
    },
    onRetry: ({ sourceId }, { repos }, progress) => repos.connectors.setSourceStatus(sourceId, 'queued', progress),
    async onFailure({ sourceId }, { repos }, reason, error) {
      // PermanentJobError: the sync already recorded the failure and told the member.
      if (error instanceof PermanentJobError) return
      const source = await repos.connectors.sourceForSync(sourceId)
      if (!source) return
      await repos.connectors.finishSync(source.id, { status: 'error', itemCount: source.syncState?.items.length ?? 0, error: reason })
      await tellCreator(repos, source, { kind: 'sync_failed', title: `Sync failed: ${source.name}`, body: reason, link: { tab: 'sources' } })
    },
  }),
}
