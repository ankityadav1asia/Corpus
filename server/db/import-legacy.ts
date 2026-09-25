import { EMBEDDING_DIMENSIONS } from '@/lib/constants'
import type { Db, Query } from '@/server/db/client'
import { usersRepository } from '@/server/repositories/users'
import { workspacesRepository } from '@/server/repositories/workspaces'

/**
 * Copies data written by the previous version of the app (public.vectorstore_documents,
 * public.conversations, public.messages) into the new per-user schema, assigning it to one
 * account. Embeddings are copied as-is, so nothing is re-embedded (no AI cost).
 *
 * Idempotent: new ids are derived from the old ones (md5 → uuid) and inserts use
 * ON CONFLICT DO NOTHING, so running it twice does not duplicate anything.
 * The legacy tables are only read, never modified.
 */

export interface LegacyImportResult {
  collections: number
  documents: number
  chunks: number
  skippedChunks: number
  conversations: number
  messages: number
}

async function tableExists(db: Db, name: string) {
  const [row] = await db.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [name])
  return Boolean(row?.present)
}

async function columnExists(db: Db, table: string, column: string) {
  const rows = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column])
  return rows.length > 0
}

/** The old app kept the real notebook in metadata->>'collection_id' (the column was always 'default'). */
function legacyCollectionName(rawExpr: string) {
  return `CASE WHEN lower(${rawExpr}) = 'default' THEN 'General' ELSE left(initcap(${rawExpr}), 80) END`
}

export async function importLegacyData(db: Db, email: string): Promise<LegacyImportResult> {
  const { user } = await usersRepository(db).upsertOnLogin(email, null)
  const owner = user.id
  // Legacy data belonged to a single user, so it lands in that user's personal workspace.
  const workspace = await workspacesRepository(db).ensurePersonal(owner)
  const result: LegacyImportResult = { collections: 0, documents: 0, chunks: 0, skippedChunks: 0, conversations: 0, messages: 0 }
  const steps: Array<{ key: keyof LegacyImportResult | null; query: Query }> = []

  if (await tableExists(db, 'public.vectorstore_documents')) {
    const rawCollection = (await columnExists(db, 'vectorstore_documents', 'collection_id'))
      ? `coalesce(nullif(v.metadata->>'collection_id', ''), nullif(v.collection_id, ''), 'default')`
      : `coalesce(nullif(v.metadata->>'collection_id', ''), 'default')`
    const collectionName = legacyCollectionName(rawCollection)
    const source = `coalesce(nullif(v.metadata->>'source', ''), 'manual-input')`
    // EMBEDDING_DIMENSIONS is a compile-time constant, not user input.
    const valid = `v.text IS NOT NULL AND btrim(v.text) <> '' AND v.embedding IS NOT NULL AND vector_dims(v.embedding) = ${EMBEDDING_DIMENSIONS}`
    const documentId = `md5($1::text || ':doc:' || ${collectionName} || ':' || ${source})::uuid`

    steps.push(
      {
        key: 'collections',
        query: {
          text: `INSERT INTO app.collections (workspace_id, created_by, name)
                 SELECT DISTINCT $2::uuid, $1::uuid, ${collectionName} FROM public.vectorstore_documents v
                 ON CONFLICT DO NOTHING RETURNING id`,
          params: [owner, workspace],
        },
      },
      {
        key: 'documents',
        query: {
          text: `WITH src AS (
                   SELECT ${collectionName} AS collection_name, ${source} AS source,
                          nullif(v.metadata->>'title', '') AS title, v.text
                   FROM public.vectorstore_documents v WHERE ${valid}
                 )
                 INSERT INTO app.documents (id, workspace_id, created_by, collection_id, source_type, source, title, status, chunk_count, char_count)
                 SELECT md5($1::text || ':doc:' || s.collection_name || ':' || s.source)::uuid, $2::uuid, $1::uuid, c.id,
                        CASE WHEN s.source LIKE 'file:%' THEN 'file'
                             WHEN s.source ~* '^https?://([a-z0-9-]+\\.)?(youtube\\.com|youtu\\.be)/' THEN 'youtube'
                             WHEN s.source ~* '^https?://' THEN 'url'
                             ELSE 'text' END,
                        left(CASE WHEN s.source LIKE 'file:%' THEN substr(s.source, 6) ELSE s.source END, 2048),
                        left(coalesce(max(s.title), CASE WHEN s.source LIKE 'file:%' THEN substr(s.source, 6) ELSE s.source END), 200),
                        'ready', count(*), sum(char_length(s.text))
                 FROM src s
                 JOIN app.collections c ON c.workspace_id = $2::uuid AND lower(c.name) = lower(s.collection_name)
                 GROUP BY s.collection_name, s.source, c.id
                 ON CONFLICT (id) DO NOTHING RETURNING id`,
          params: [owner, workspace],
        },
      },
      {
        key: 'chunks',
        query: {
          text: `INSERT INTO app.chunks (id, document_id, workspace_id, collection_id, chunk_index, content, embedding, embedding_model)
                 SELECT md5($1::text || ':chunk:' || v.id::text)::uuid, d.id, $2::uuid, d.collection_id,
                        (row_number() OVER (PARTITION BY d.id ORDER BY v.id) - 1)::int,
                        v.text, v.embedding::vector(${EMBEDDING_DIMENSIONS}), 'gemini-embedding-001'
                 FROM public.vectorstore_documents v
                 JOIN app.documents d ON d.id = ${documentId} AND d.workspace_id = $2::uuid
                 WHERE ${valid}
                 ON CONFLICT (id) DO NOTHING RETURNING id`,
          params: [owner, workspace],
        },
      },
      {
        key: null, // skipped-chunk count, read below
        query: {
          text: `SELECT (count(*) - count(*) FILTER (WHERE ${valid}))::int AS skipped FROM public.vectorstore_documents v`,
        },
      },
    )
  }

  if (await tableExists(db, 'public.conversations')) {
    steps.push(
      {
        key: 'conversations',
        query: {
          text: `INSERT INTO app.conversations (id, workspace_id, owner_id, collection_id, title, created_at, updated_at)
                 SELECT md5($1::text || ':conv:' || lc.id)::uuid, $2::uuid, $1::uuid, col.id,
                        left(coalesce(nullif(btrim(lc.title), ''), 'Imported conversation'), 200),
                        coalesce(lc.created_at, now()), coalesce(lc.updated_at, lc.created_at, now())
                 FROM public.conversations lc
                 LEFT JOIN app.collections col ON col.workspace_id = $2::uuid
                   AND lower(col.name) = lower(${legacyCollectionName(`coalesce(nullif(lc.collection_id, ''), 'default')`)})
                 ON CONFLICT (id) DO NOTHING RETURNING id`,
          params: [owner, workspace],
        },
      },
      {
        key: null,
        query: {
          text: `UPDATE app.conversations n SET parent_id = md5($1::text || ':conv:' || lc.parent_id)::uuid
                 FROM public.conversations lc
                 WHERE n.id = md5($1::text || ':conv:' || lc.id)::uuid AND n.owner_id = $1::uuid
                   AND lc.parent_id IS NOT NULL AND n.parent_id IS NULL
                   AND EXISTS (SELECT 1 FROM app.conversations p WHERE p.id = md5($1::text || ':conv:' || lc.parent_id)::uuid)`,
          params: [owner],
        },
      },
    )

    if (await tableExists(db, 'public.messages')) {
      // Strips the old in-band <!--CITATIONS:…--> markers that the branching bug persisted into content.
      const cleaned = `btrim(regexp_replace(m.content, '<!--(CITATIONS|AGENT_STEPS):.*?-->', '', 'g'))`
      steps.push({
        key: 'messages',
        query: {
          text: `INSERT INTO app.messages (id, conversation_id, role, content, citations, created_at)
                 SELECT md5($1::text || ':msg:' || m.id)::uuid, md5($1::text || ':conv:' || m.conversation_id)::uuid, m.role, ${cleaned},
                        coalesce((
                          SELECT jsonb_agg(jsonb_build_object(
                                   'index', CASE WHEN e->>'index' ~ '^[0-9]+$' THEN (e->>'index')::int ELSE 0 END,
                                   'chunkId', NULL, 'documentId', NULL,
                                   'title', coalesce(e->>'source', 'Source'), 'source', coalesce(e->>'source', ''),
                                   'sourceType', NULL, 'excerpt', coalesce(e->>'excerpt', ''), 'similarity', NULL))
                          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.citations) = 'array' THEN m.citations ELSE '[]'::jsonb END) e
                        ), '[]'::jsonb),
                        coalesce(m.created_at, now())
                 FROM public.messages m
                 WHERE m.role IN ('user', 'assistant') AND ${cleaned} <> ''
                   AND EXISTS (SELECT 1 FROM app.conversations c
                               WHERE c.id = md5($1::text || ':conv:' || m.conversation_id)::uuid AND c.owner_id = $1::uuid)
                 ORDER BY m.created_at, m.id
                 ON CONFLICT (id) DO NOTHING RETURNING id`,
          params: [owner],
        },
      })
    }
  }

  if (steps.length === 0) return result
  const outputs = await db.transaction(steps.map((step) => step.query))
  steps.forEach((step, index) => {
    const rows = outputs[index] ?? []
    if (step.key) result[step.key] = rows.length
    else if (rows[0] && 'skipped' in rows[0]) result.skippedChunks = Number(rows[0].skipped)
  })
  return result
}
