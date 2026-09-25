import { z } from 'zod'

import type { AiProvider } from '@/server/ai/provider'
import type { Repositories } from '@/server/repositories'

/**
 * After switching embedding models (e.g. Gemini → an open-source model), stored vectors come from the
 * old model and are skipped by vector search (keyword search still finds them). This job re-embeds a
 * workspace's passages with the active model in steps, so it can run across several job runs.
 */

export const reembedPayload = z.object({ workspaceId: z.guid() })

const STEP = 100

export async function reembedWorkspace(deps: { repos: Pick<Repositories, 'chunks'>; ai: AiProvider }, workspaceId: string, deadline: number): Promise<'done' | 'more'> {
  const model = deps.ai.embeddingModel
  for (;;) {
    if (Date.now() > deadline) return 'more'
    const rows = await deps.repos.chunks.toReembed(workspaceId, model, STEP)
    if (rows.length === 0) return 'done'
    const vectors = await deps.ai.embedDocuments(rows.map((row) => row.content))
    if (vectors.length !== rows.length) throw new Error('Embedding count mismatch')
    await deps.repos.chunks.setEmbeddings(
      workspaceId,
      rows.map((row, index) => ({ id: row.id, embedding: vectors[index]! })),
      model,
    )
  }
}
