import { branchConversationSchema, idSchema } from '@/lib/contracts'
import { parseWith, readJson } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

/** Forks the thread at `messageId` into a new conversation (copied server-side). */
export const POST = workspaceRoute<{ id: string }>(async ({ req, params, access }) => {
  const id = parseWith(idSchema, params.id)
  const { messageId } = await readJson(req, branchConversationSchema)
  const conversationId = await getServices().repos.conversations.branch(access.workspaceId, access.userId, id, messageId)
  if (!conversationId) throw Errors.notFound('Message')
  return json({ conversationId }, { status: 201 })
})
