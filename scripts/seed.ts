/**
 * Adds a short sample document to the first notebook of a user's personal workspace
 * (creates the user and workspace if needed).
 *   npm run seed -- --email you@example.com
 */
import 'dotenv/config'

import { createGeminiProvider } from '@/server/ai/gemini'
import { createDb, type Db } from '@/server/db/client'
import { getSchemaStatus } from '@/server/db/migrate'
import { ingestDocument } from '@/server/ingestion/ingest-service'
import { createRepositories } from '@/server/repositories'

const SAMPLE = `
Corpus is a retrieval-augmented generation (RAG) workspace. Every account has a private personal
workspace, and teams can create shared workspaces with Admin, Editor and Viewer roles.

How a question is answered:
1. The question is rewritten into several search queries (multi-query), a broader step-back question
   and a hypothetical answer passage (HyDE).
2. Postgres runs two searches for every query, scoped to the notebook: pgvector cosine similarity and
   full-text search. All ranked lists are merged with Reciprocal Rank Fusion into about 20 candidates.
3. A re-ranker scores each candidate against the question and keeps the best 5.
4. If even the best passage is not relevant enough, the answer is exactly
   "Insufficient context in knowledge base." instead of a guess.
5. Otherwise the passages are sent to Gemini with instructions to answer only from them and cite [1], [2].

Answers are graded in the background for faithfulness, answer relevance and context precision.
`.trim()

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** Adds the sample document to the user's first notebook (creating the account and notebook if needed). */
async function seedSample(db: Db, email: string, apiKey: string) {
  if (!(await getSchemaStatus(db)).ready) throw new Error('Run `npm run db:migrate` first.')

  const repos = createRepositories(db)
  const { user } = await repos.users.upsertOnLogin(email, null)
  const workspaceId = await repos.workspaces.ensurePersonal(user.id)
  await repos.collections.ensureDefault(workspaceId, user.id)
  const [collection] = await repos.collections.list(workspaceId, user.id)
  if (!collection) throw new Error('Could not find or create a notebook')

  const ai = createGeminiProvider({
    apiKey,
    chatModel: process.env.GEMINI_CHAT_MODEL?.trim() || 'gemini-3.6-flash',
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL?.trim() || 'gemini-embedding-001',
  })
  const { document } = await ingestDocument(
    { repos, ai },
    {
      workspaceId,
      collectionId: collection.id,
      createdBy: user.id,
      sourceType: 'text',
      source: 'seed-script',
      title: 'How Corpus answers questions (sample)',
      text: SAMPLE,
      replaceExisting: true,
    },
  )
  console.log(`✓ Added "${document.title}" (${document.chunkCount} chunks) to "${collection.name}" for ${email}`)
}

async function main() {
  const email = argument('--email')?.trim().toLowerCase()
  if (!email || !email.includes('@')) throw new Error('Usage: npm run seed -- --email you@example.com')
  const url = process.env.POSTGRES_URL?.trim()
  const apiKey = (process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY)?.trim()
  if (!url || !apiKey) throw new Error('POSTGRES_URL and GOOGLE_API_KEY must be set in .env')

  const db = createDb(url)
  try {
    await seedSample(db, email, apiKey)
  } finally {
    await db.close()
  }
}

main().catch((error) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
