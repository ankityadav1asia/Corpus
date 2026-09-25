import { LIMITS } from '@/lib/constants'
import { evalCaseSchema } from '@/lib/contracts'
import { collectionAccess, requireWorkspacePermission } from '@/server/auth/access'
import { readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/** Benchmark questions with reference answers (any member can see them). */
export const GET = workspaceRoute(async ({ access }) => {
  return json({ cases: await getServices().repos.evaluations.cases(access.workspaceId) })
})

/** Adds a benchmark question (Editor). */
export const POST = workspaceRoute(async ({ req, access }) => {
  requireWorkspacePermission(access, 'evaluation.manage')
  const input = await readJson(req, evalCaseSchema, 32 * 1024)
  const { repos } = getServices()
  if (input.collectionId) await collectionAccess(repos, access, input.collectionId)
  if ((await repos.evaluations.caseCount(access.workspaceId)) >= LIMITS.evalCasesPerWorkspace) {
    throw Errors.conflict(`A workspace can have at most ${LIMITS.evalCasesPerWorkspace} benchmark questions.`)
  }
  const testCase = await repos.evaluations.addCase({
    workspaceId: access.workspaceId,
    question: input.question,
    referenceAnswer: input.referenceAnswer,
    collectionId: input.collectionId ?? null,
    createdBy: access.userId,
  })
  return json({ case: testCase }, { status: 201 })
})
