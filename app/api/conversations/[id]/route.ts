import { conversationUpdateSchema, idSchema, type ConversationDetail } from '@/lib/contracts'
import { parseWith, readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { processJobsAfterResponse } from '@/server/jobs/trigger'
import { getServices } from '@/server/services'

type Params = { id: string }

export const GET = workspaceRoute<Params>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { repos } = getServices()
  const conversation = await repos.conversations.get(access.workspaceId, access.userId, id)
  if (!conversation) throw Errors.notFound('Conversation')
  // The UI polls this for answer-quality scores; give queued evaluations a chance to run.
  processJobsAfterResponse()
  return json<ConversationDetail>({ conversation, messages: await repos.conversations.messages(id, access.userId) })
})

/** Rename and/or pin (pinned conversations are listed first). */
export const PATCH = workspaceRoute<Params>(async ({ req, params, access }) => {
  const id = parseWith(idSchema, params.id)
  const input = await readJson(req, conversationUpdateSchema)
  const { repos } = getServices()
  let conversation = await repos.conversations.get(access.workspaceId, access.userId, id)
  if (!conversation) throw Errors.notFound('Conversation')
  if (input.title !== undefined) conversation = await repos.conversations.rename(access.workspaceId, access.userId, id, input.title)
  if (input.pinned !== undefined && conversation) conversation = await repos.conversations.setPinned(access.workspaceId, access.userId, id, input.pinned)
  if (!conversation) throw Errors.notFound('Conversation')
  return json({ conversation })
})

export const DELETE = workspaceRoute<Params>(async ({ params, access }) => {
  const id = parseWith(idSchema, params.id)
  if (!(await getServices().repos.conversations.delete(access.workspaceId, access.userId, id))) throw Errors.notFound('Conversation')
  return json({ ok: true })
})
