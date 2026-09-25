import { z } from 'zod'

import { INSUFFICIENT_CONTEXT_MESSAGE } from '@/lib/constants'
import { notify } from '@/server/activity'
import type { AiProvider } from '@/server/ai/provider'
import { judgeAnswer } from '@/server/evaluation/judge'
import { buildUserPrompt, normalizeTurns, systemPrompt } from '@/server/rag/prompt'
import type { Reranker } from '@/server/rag/rerank'
import { retrieve, type RankedHit } from '@/server/rag/retrieval'
import type { Repositories } from '@/server/repositories'

export interface EvaluationDeps {
  repos: Pick<Repositories, 'conversations' | 'documents' | 'chunks' | 'evaluations' | 'workspaces' | 'notifications'>
  ai: AiProvider
  reranker: Reranker | null
}

export const evaluateAnswerPayload = z.object({ messageId: z.guid(), chunkIds: z.array(z.guid()).max(50) })
export const benchmarkPayload = z.object({ runId: z.guid() })

/** Scores one live answer against the passages it was generated from. */
export async function evaluateMessage(deps: EvaluationDeps, payload: z.infer<typeof evaluateAnswerPayload>): Promise<'scored' | 'skipped'> {
  const target = await deps.repos.conversations.questionFor(payload.messageId)
  if (!target) return 'skipped' // message or conversation deleted meanwhile
  const passages = await deps.repos.chunks.texts(target.workspaceId, payload.chunkIds)
  const { scores, details } = await judgeAnswer(deps.ai, {
    question: target.question,
    answer: target.answer,
    passages: passages.map((passage) => passage.content),
    reference: null,
  })
  await deps.repos.evaluations.save({
    workspaceId: target.workspaceId,
    messageId: payload.messageId,
    question: target.question,
    answer: target.answer,
    scores,
    details: { ...details, chunkIds: passages.map((passage) => passage.id) },
    model: deps.ai.chatModel,
  })
  return 'scored'
}

async function generateAnswer(ai: AiProvider, question: string, hits: readonly RankedHit[]): Promise<string> {
  let answer = ''
  const turns = normalizeTurns([{ role: 'user', content: buildUserPrompt(question, hits) }])
  for await (const text of ai.streamChat({ system: systemPrompt('standard'), turns })) answer += text
  return answer.trim()
}

/**
 * Runs benchmark cases through the real pipeline (retrieve → re-rank → guardrail → answer) and
 * scores them against their reference answers. Stops at `deadline` and reports 'more' so the job
 * can be continued by a fresh job instead of hitting a serverless timeout.
 */
export async function runBenchmarkBatch(deps: EvaluationDeps, payload: z.infer<typeof benchmarkPayload>, deadline: number): Promise<'done' | 'more' | 'missing'> {
  const run = await deps.repos.evaluations.runForJob(payload.runId)
  if (!run) return 'missing'
  await deps.repos.evaluations.markRun(run.id, 'running')

  const [cases, scored, settings] = await Promise.all([
    deps.repos.evaluations.cases(run.workspaceId),
    deps.repos.evaluations.scoredCaseIds(run.id),
    deps.repos.workspaces.settings(run.workspaceId),
  ])

  for (const testCase of cases) {
    if (scored.has(testCase.id)) continue
    if (Date.now() > deadline) return 'more'
    const retrieval = await retrieve(
      { repos: deps.repos, ai: deps.ai, reranker: deps.reranker },
      { workspaceId: run.workspaceId, collectionId: testCase.collectionId },
      { question: testCase.question, mode: 'standard', history: [], settings },
    )
    const hits = retrieval.guardrail.pass ? retrieval.hits : []
    const answer = hits.length ? await generateAnswer(deps.ai, testCase.question, hits) : INSUFFICIENT_CONTEXT_MESSAGE
    const { scores, details } = await judgeAnswer(deps.ai, {
      question: testCase.question,
      answer,
      passages: retrieval.hits.map((hit) => hit.content),
      reference: testCase.referenceAnswer,
    })
    await deps.repos.evaluations.save({
      workspaceId: run.workspaceId,
      runId: run.id,
      caseId: testCase.id,
      question: testCase.question,
      answer,
      scores,
      details: { ...details, guardrail: retrieval.guardrail, chunkIds: retrieval.hits.map((hit) => hit.chunkId) },
      model: deps.ai.chatModel,
    })
    await deps.repos.evaluations.incrementRunProgress(run.id)
  }

  await deps.repos.evaluations.markRun(run.id, 'completed')
  if (run.createdBy) {
    const [finished] = await deps.repos.evaluations.runs(run.workspaceId, 1)
    const recall = finished?.averages.contextRecall
    await notify(deps.repos, {
      userId: run.createdBy,
      workspaceId: run.workspaceId,
      kind: 'benchmark_done',
      title: 'Benchmark run finished',
      body: `${cases.length} question${cases.length === 1 ? '' : 's'} scored${recall === null || recall === undefined ? '' : ` · context recall ${Math.round(recall * 100)}%`}.`,
      link: { tab: 'analytics' },
    })
  }
  return 'done'
}
