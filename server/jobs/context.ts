import type { ImageGenerator } from '@/server/ai/image'
import type { SpeechSynthesizer, Transcriber, VisionModel } from '@/server/ai/media'
import type { AiProvider } from '@/server/ai/provider'
import type { ConnectorRegistry } from '@/server/connectors/registry'
import type { OcrEngine } from '@/server/media/ocr'
import type { Reranker } from '@/server/rag/rerank'
import type { Repositories } from '@/server/repositories'
import type { SecretKeys } from '@/server/security/keys'

/** What background jobs may use. Capabilities are lazy so a job only builds what it needs. */
export interface JobContext {
  repos: Repositories
  ai: () => AiProvider
  reranker: () => Reranker | null
  images: () => ImageGenerator | null
  /** Multimodal capabilities (absent = turned off). */
  vision?: () => VisionModel | null
  transcriber?: () => Transcriber | null
  speech?: () => SpeechSynthesizer | null
  ocr?: () => OcrEngine | null
  connectors?: () => ConnectorRegistry
  /** AUTH_SECRET key ring, to open encrypted connector and chat-app credentials. */
  secret?: () => SecretKeys
  /** Outbound HTTP for chat-app replies (injectable for tests). */
  fetch?: typeof fetch
}
