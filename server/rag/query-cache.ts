/**
 * Small in-process cache of query embeddings. Asking the same (or a suggested follow-up) question
 * again skips the embedding round trip. One cache per provider instance, keyed by embedding model,
 * so switching models never mixes vectors. Bounded (LRU) and short-lived.
 */

const MAX_ENTRIES = 500
const TTL_MS = 60 * 60 * 1000

type Cache = Map<string, { vector: number[]; expires: number }>

const caches = new WeakMap<object, Cache>()

function cacheFor(owner: object): Cache {
  let cache = caches.get(owner)
  if (!cache) {
    cache = new Map()
    caches.set(owner, cache)
  }
  return cache
}

const keyOf = (model: string, text: string) => `${model}\n${text.trim().toLowerCase()}`

function cached(entries: Cache, model: string, text: string, now: number): number[] | null {
  const key = keyOf(model, text)
  const entry = entries.get(key)
  if (!entry) return null
  if (entry.expires <= now) {
    entries.delete(key)
    return null
  }
  // Refresh recency: Map keeps insertion order, so re-inserting moves it to the end.
  entries.delete(key)
  entries.set(key, entry)
  return entry.vector
}

function remember(entries: Cache, model: string, text: string, vector: number[], now: number) {
  const key = keyOf(model, text)
  entries.delete(key)
  entries.set(key, { vector, expires: now + TTL_MS })
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!)
}

/** Embeds the queries that are not cached (in one request) and returns vectors in input order. */
export async function embedQueriesCached(
  ai: { embeddingModel: string; embedQueries(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> },
  queries: readonly string[],
  signal?: AbortSignal,
  now = Date.now(),
): Promise<number[][]> {
  const entries = cacheFor(ai)
  const vectors = queries.map((query) => cached(entries, ai.embeddingModel, query, now))
  const missing = queries.filter((_, index) => vectors[index] === null)
  if (missing.length > 0) {
    const fresh = await ai.embedQueries(missing, signal)
    let next = 0
    queries.forEach((query, index) => {
      if (vectors[index] !== null) return
      const vector = fresh[next++]!
      vectors[index] = vector
      remember(entries, ai.embeddingModel, query, vector, now)
    })
  }
  return vectors as number[][]
}

/** A signal that also aborts after `ms` (for stages that must not hold up the answer). */
export function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}
