import type { ChatMessage, Citation, ConversationSummary, EvaluationScores, RetrievalStep } from '@/lib/contracts'
import type { Db } from '@/server/db/client'
import { asJsonArray, escapeLike, toIso, toNullableNumber } from '@/server/repositories/sql'

const CONVERSATION_COLUMNS = `id, title, collection_id, parent_id, pinned_at, created_at, updated_at`

function mapConversation(row: Record<string, unknown>): ConversationSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    collectionId: row.collection_id ? String(row.collection_id) : null,
    parentId: row.parent_id ? String(row.parent_id) : null,
    pinned: row.pinned_at !== null && row.pinned_at !== undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapEvaluation(row: Record<string, unknown>): EvaluationScores | null {
  if (!row.evaluation_id) return null
  return {
    faithfulness: toNullableNumber(row.faithfulness),
    answerRelevance: toNullableNumber(row.answer_relevance),
    contextPrecision: toNullableNumber(row.context_precision),
    contextRecall: toNullableNumber(row.context_recall),
  }
}

function mapFeedback(row: Record<string, unknown>): ChatMessage['feedback'] {
  if (row.feedback_rating === null || row.feedback_rating === undefined) return null
  return { rating: Number(row.feedback_rating) === 1 ? 1 : -1, comment: row.feedback_comment ? String(row.feedback_comment) : null }
}

function mapMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: String(row.id),
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: String(row.content),
    citations: asJsonArray<Citation>(row.citations),
    steps: asJsonArray<RetrievalStep>(row.steps),
    createdAt: toIso(row.created_at),
    evaluation: mapEvaluation(row),
    feedback: mapFeedback(row),
    followups: Array.isArray(row.followups) ? (row.followups as unknown[]).filter((item): item is string => typeof item === 'string') : null,
  }
}

export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

/** Conversations are private to their author inside a workspace: every query checks both. */
export function conversationsRepository(db: Db) {
  return {
    async list(workspaceId: string, ownerId: string, limit = 100): Promise<ConversationSummary[]> {
      const rows = await db.query(
        `SELECT ${CONVERSATION_COLUMNS} FROM app.conversations WHERE workspace_id = $1 AND owner_id = $2
         ORDER BY pinned_at DESC NULLS LAST, updated_at DESC LIMIT $3`,
        [workspaceId, ownerId, limit],
      )
      return rows.map(mapConversation)
    },

    /** The author's conversations whose title or any message contains `query` (literally), newest first. */
    async search(workspaceId: string, ownerId: string, query: string, limit = 50): Promise<ConversationSummary[]> {
      const rows = await db.query(
        `SELECT ${CONVERSATION_COLUMNS} FROM app.conversations c
         WHERE c.workspace_id = $1 AND c.owner_id = $2
           AND (c.title ILIKE $3 ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM app.messages m WHERE m.conversation_id = c.id AND m.content ILIKE $3 ESCAPE '\\'))
         ORDER BY c.updated_at DESC LIMIT $4`,
        [workspaceId, ownerId, `%${escapeLike(query)}%`, limit],
      )
      return rows.map(mapConversation)
    },

    async get(workspaceId: string, ownerId: string, id: string): Promise<ConversationSummary | null> {
      const [row] = await db.query(`SELECT ${CONVERSATION_COLUMNS} FROM app.conversations WHERE id = $1 AND workspace_id = $2 AND owner_id = $3`, [id, workspaceId, ownerId])
      return row ? mapConversation(row) : null
    },

    async create(input: { workspaceId: string; ownerId: string; collectionId: string | null; title: string }): Promise<ConversationSummary> {
      const [row] = await db.query(`INSERT INTO app.conversations (workspace_id, owner_id, collection_id, title) VALUES ($1, $2, $3, $4) RETURNING ${CONVERSATION_COLUMNS}`, [
        input.workspaceId,
        input.ownerId,
        input.collectionId,
        input.title,
      ])
      if (!row) throw new Error('Conversation insert returned no row')
      return mapConversation(row)
    },

    async rename(workspaceId: string, ownerId: string, id: string, title: string): Promise<ConversationSummary | null> {
      const [row] = await db.query(
        `UPDATE app.conversations SET title = $4, updated_at = now() WHERE id = $1 AND workspace_id = $2 AND owner_id = $3 RETURNING ${CONVERSATION_COLUMNS}`,
        [id, workspaceId, ownerId, title],
      )
      return row ? mapConversation(row) : null
    },

    async setPinned(workspaceId: string, ownerId: string, id: string, pinned: boolean): Promise<ConversationSummary | null> {
      const [row] = await db.query(
        `UPDATE app.conversations SET pinned_at = CASE WHEN $4 THEN coalesce(pinned_at, now()) ELSE NULL END
         WHERE id = $1 AND workspace_id = $2 AND owner_id = $3 RETURNING ${CONVERSATION_COLUMNS}`,
        [id, workspaceId, ownerId, pinned],
      )
      return row ? mapConversation(row) : null
    },

    async delete(workspaceId: string, ownerId: string, id: string): Promise<boolean> {
      const rows = await db.query(`DELETE FROM app.conversations WHERE id = $1 AND workspace_id = $2 AND owner_id = $3 RETURNING id`, [id, workspaceId, ownerId])
      return rows.length > 0
    },

    /** Records activity and remembers the notebook used most recently in this thread. */
    async touch(id: string, collectionId: string | null): Promise<void> {
      await db.query(`UPDATE app.conversations SET updated_at = now(), collection_id = $2 WHERE id = $1`, [id, collectionId])
    },

    /**
     * Caller must have verified ownership of the conversation. Includes background quality scores
     * and, when `viewerId` is given, that person's own rating of each answer.
     */
    async messages(conversationId: string, viewerId: string | null = null): Promise<ChatMessage[]> {
      const rows = await db.query(
        `SELECT m.id, m.role, m.content, m.citations, m.steps, m.created_at, m.followups,
                e.id AS evaluation_id, e.faithfulness, e.answer_relevance, e.context_precision, e.context_recall,
                f.rating AS feedback_rating, f.comment AS feedback_comment
         FROM app.messages m
         LEFT JOIN app.evaluations e ON e.message_id = m.id
         LEFT JOIN app.message_feedback f ON f.message_id = m.id AND f.user_id = $2
         WHERE m.conversation_id = $1
         ORDER BY m.seq`,
        [conversationId, viewerId],
      )
      return rows.map(mapMessage)
    },

    /** Who may rate a message: its conversation's author, inside that workspace. */
    async messageContext(messageId: string): Promise<{ workspaceId: string; ownerId: string; role: 'user' | 'assistant' } | null> {
      const [row] = await db.query(`SELECT c.workspace_id, c.owner_id, m.role FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id WHERE m.id = $1`, [
        messageId,
      ])
      return row ? { workspaceId: String(row.workspace_id), ownerId: String(row.owner_id), role: row.role === 'assistant' ? 'assistant' : 'user' } : null
    },

    /** An answer with its question, for suggesting follow-ups (caller checks workspace and owner). */
    async followupSource(messageId: string): Promise<{
      workspaceId: string
      ownerId: string
      role: 'user' | 'assistant'
      question: string | null
      answer: string
      citations: Citation[]
      followups: string[] | null
    } | null> {
      const [row] = await db.query(
        `SELECT c.workspace_id, c.owner_id, a.role, a.content AS answer, a.citations, a.followups,
                (SELECT q.content FROM app.messages q WHERE q.conversation_id = a.conversation_id AND q.seq < a.seq AND q.role = 'user' ORDER BY q.seq DESC LIMIT 1) AS question
         FROM app.messages a JOIN app.conversations c ON c.id = a.conversation_id
         WHERE a.id = $1`,
        [messageId],
      )
      if (!row) return null
      return {
        workspaceId: String(row.workspace_id),
        ownerId: String(row.owner_id),
        role: row.role === 'assistant' ? 'assistant' : 'user',
        question: row.question ? String(row.question) : null,
        answer: String(row.answer),
        citations: asJsonArray<Citation>(row.citations),
        followups: Array.isArray(row.followups) ? (row.followups as string[]) : null,
      }
    },

    async setFollowups(messageId: string, followups: readonly string[]): Promise<void> {
      await db.query(`UPDATE app.messages SET followups = $2::jsonb WHERE id = $1`, [messageId, JSON.stringify(followups)])
    },

    /** Most recent turns, oldest first, for the model's conversational context. */
    async recentTurns(conversationId: string, limit: number): Promise<Turn[]> {
      const rows = await db.query<{ role: string; content: string }>(
        `SELECT role, content FROM (
           SELECT role, content, seq FROM app.messages WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2
         ) recent ORDER BY seq`,
        [conversationId, limit],
      )
      return rows.map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', content: String(row.content) }))
    },

    async addMessage(input: { conversationId: string; role: 'user' | 'assistant'; content: string; citations?: Citation[]; steps?: RetrievalStep[] }): Promise<ChatMessage> {
      const [row] = await db.query(
        `INSERT INTO app.messages (conversation_id, role, content, citations, steps)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         RETURNING id, role, content, citations, steps, created_at`,
        [input.conversationId, input.role, input.content, JSON.stringify(input.citations ?? []), JSON.stringify(input.steps ?? [])],
      )
      if (!row) throw new Error('Message insert returned no row')
      return mapMessage(row)
    },

    /** The user question that an assistant message answered (for background evaluation). */
    async questionFor(messageId: string): Promise<{ question: string; answer: string; citations: Citation[]; workspaceId: string } | null> {
      const [row] = await db.query(
        `SELECT a.content AS answer, a.citations, c.workspace_id,
                (SELECT q.content FROM app.messages q WHERE q.conversation_id = a.conversation_id AND q.seq < a.seq AND q.role = 'user' ORDER BY q.seq DESC LIMIT 1) AS question
         FROM app.messages a JOIN app.conversations c ON c.id = a.conversation_id
         WHERE a.id = $1 AND a.role = 'assistant'`,
        [messageId],
      )
      if (!row || !row.question) return null
      return { question: String(row.question), answer: String(row.answer), citations: asJsonArray<Citation>(row.citations), workspaceId: String(row.workspace_id) }
    },

    /**
     * Copies the thread up to and including `messageId` into a new conversation, server-side and
     * in one statement (the old client-driven copy reused message ids and silently copied nothing).
     */
    async branch(workspaceId: string, ownerId: string, conversationId: string, messageId: string): Promise<string | null> {
      const rows = await db.query<{ conversation_id: string }>(
        `WITH source_conversation AS (
           SELECT id, collection_id, title FROM app.conversations WHERE id = $1 AND workspace_id = $4 AND owner_id = $2
         ),
         pivot AS (
           SELECT m.seq FROM app.messages m JOIN source_conversation s ON s.id = m.conversation_id WHERE m.id = $3
         ),
         new_conversation AS (
           INSERT INTO app.conversations (workspace_id, owner_id, collection_id, parent_id, title)
           SELECT $4, $2, s.collection_id, s.id, left('↳ ' || s.title, 200)
           FROM source_conversation s
           WHERE EXISTS (SELECT 1 FROM pivot)
           RETURNING id
         )
         INSERT INTO app.messages (conversation_id, role, content, citations, steps, created_at)
         SELECT n.id, m.role, m.content, m.citations, m.steps, m.created_at
         FROM app.messages m, new_conversation n, pivot p
         WHERE m.conversation_id = $1 AND m.seq <= p.seq
         ORDER BY m.seq
         RETURNING conversation_id`,
        [conversationId, ownerId, messageId, workspaceId],
      )
      return rows[0] ? String(rows[0].conversation_id) : null
    },
  }
}
