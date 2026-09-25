/**
 * Everything the RAG pipeline needs from a model vendor. Services depend on this interface,
 * not on an SDK, so the vendor can be swapped (or faked in tests) without touching them.
 */
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface CompletionInput {
  system: string
  prompt: string
  /** Ask the model for a JSON response (parsers stay defensive either way). */
  json?: boolean
  temperature?: number
  /**
   * A short helper call (re-ranking, query planning, judging, suggestions): use the fast model when
   * one is configured and skip "thinking", which otherwise adds seconds before any output.
   */
  fast?: boolean
  signal?: AbortSignal
}

export interface AiProvider {
  /** Model identifier recorded next to evaluation scores. */
  readonly chatModel: string
  /**
   * Identity of the embedding model. Stored with every chunk: vectors from different models are not
   * comparable, so search only compares vectors of the active model (see server/rag/reembed.ts).
   */
  readonly embeddingModel: string
  /** Embeddings for stored passages (RETRIEVAL_DOCUMENT task type). Same order as input. */
  embedDocuments(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>
  /** Embedding for one search query (RETRIEVAL_QUERY task type). */
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>
  /** Embeddings for several search queries in one request. Same order as input. */
  embedQueries(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>
  /**
   * Streams answer text. `turns` must start with a user turn and alternate roles. `fast` skips the
   * model's thinking phase so the first words arrive sooner (standard mode); deep mode keeps it.
   */
  streamChat(input: { system: string; turns: readonly ChatTurn[]; fast?: boolean; signal?: AbortSignal }): AsyncIterable<string>
  /** Non-streaming completion (query transforms, re-ranking, judging, synthesis). */
  complete(input: CompletionInput): Promise<string>
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    /** Wait the vendor asked for (e.g. until a per-minute quota resets), when it said. */
    readonly retryAfterSeconds?: number,
    /** A per-day quota is used up (or is zero on this plan): retrying within minutes cannot help. */
    readonly dailyQuota = false,
  ) {
    super(message)
    this.name = 'AiProviderError'
  }
}

export const DAILY_QUOTA_MESSAGE = "The AI provider's daily quota for this model has been reached. It resets once a day — try again later, or use an API key with billing enabled."

/** What users are told about a vendor failure (vendor messages can contain internals). */
export function aiErrorMessage(error: AiProviderError): string {
  if (error.dailyQuota) return DAILY_QUOTA_MESSAGE
  if (error.status === 429) return 'The AI service is rate-limiting requests. Please try again in a minute.'
  return 'The AI service could not respond right now. Please try again shortly.'
}
