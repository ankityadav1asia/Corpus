import 'server-only'

import { createAnthropicChat } from '@/server/ai/anthropic'
import { createGeminiProvider } from '@/server/ai/gemini'
import { DEFAULT_GEMINI_VOICES, createGeminiSpeech, createGeminiTranscriber, createGeminiVision } from '@/server/ai/gemini-media'
import type { SpeechSynthesizer, Transcriber, VisionModel } from '@/server/ai/media'
import { combineProviders, createOpenAiCompatibleChat, createOpenAiCompatibleEmbeddings } from '@/server/ai/openai-compatible'
import { createOpenAiCompatibleSpeech, createOpenAiCompatibleTranscriber, createOpenAiCompatibleVision } from '@/server/ai/openai-compatible-media'
import type { AiProvider } from '@/server/ai/provider'
import { setUsageSink } from '@/server/ai/usage'
import { createConnectorRegistry, type ConnectorRegistry } from '@/server/connectors/registry'
import { createDb, type Db } from '@/server/db/client'
import { createEmailSender, type EmailSender } from '@/server/email/sender'
import {
  getChatBackend,
  getCoreEnv,
  getEmailConfig,
  getEmbeddingBackend,
  getFastChatModel,
  getOAuthClient,
  getOcrConfig,
  getRerankerConfig,
  getSpeechBackend,
  getTranscriptionBackend,
  getVisionBackend,
  type ChatBackend,
  type ModelBackend,
} from '@/server/env'
import { createTesseractOcr, createVisionOcr, type OcrEngine } from '@/server/media/ocr'
import { createCohereReranker, createLlmReranker, type Reranker } from '@/server/rag/rerank'
import { createRepositories, type Repositories } from '@/server/repositories'

/**
 * Composition root: the one place that knows which concrete database, model vendors (Gemini or an
 * OpenAI-compatible open-source model server), re-ranker, OCR engine and email provider the app uses.
 * Route handlers ask for services; tests swap them out.
 */
export interface Services {
  db: Db
  repos: Repositories
  /** Lazily created so pages that never call the model work without an API key. */
  ai(): AiProvider
  /** null when re-ranking is disabled (RERANKER=none). */
  reranker(): Reranker | null
  /** Reads images (text + description); null when no vision model is configured. */
  vision(): VisionModel | null
  /** Audio/video to text; null when not configured. */
  transcriber(): Transcriber | null
  /** Text-to-speech for audio overviews; null when not configured. */
  speech(): SpeechSynthesizer | null
  /** A fresh OCR engine (close it when done); null when OCR_ENGINE=none. */
  ocr(): OcrEngine | null
  /** Google Drive, Notion, GitHub and website connectors. */
  connectors(): ConnectorRegistry
  email(): EmailSender | null
  /** Outbound HTTP to chat apps (Slack, Microsoft); tests inject a fake. Defaults to global fetch. */
  fetch?: () => typeof fetch
}

let instance: Services | null = null

function compatible(backend: Extract<ModelBackend, { provider: 'openai-compatible' }>) {
  return { baseUrl: backend.baseUrl, apiKey: backend.apiKey, model: backend.model }
}

/** Chat and embeddings can come from different back ends (e.g. an open-source chat model with Gemini embeddings). */
export function createAiProvider(chat: ChatBackend, embeddings: ModelBackend, fastModel: string | null = null): AiProvider {
  if (chat.provider === 'gemini' && embeddings.provider === 'gemini' && chat.apiKey === embeddings.apiKey) {
    return createGeminiProvider({ apiKey: chat.apiKey, chatModel: chat.model, embeddingModel: embeddings.model, fastModel })
  }
  const chatPart =
    chat.provider === 'gemini'
      ? createGeminiProvider({ apiKey: chat.apiKey, chatModel: chat.model, embeddingModel: 'unused', fastModel })
      : chat.provider === 'anthropic'
        ? createAnthropicChat({ apiKey: chat.apiKey, model: chat.model, fastModel })
        : createOpenAiCompatibleChat({ ...compatible(chat), fastModel })
  const embeddingPart =
    embeddings.provider === 'gemini'
      ? createGeminiProvider({ apiKey: embeddings.apiKey, chatModel: 'unused', embeddingModel: embeddings.model })
      : createOpenAiCompatibleEmbeddings(compatible(embeddings))
  return combineProviders(chatPart, embeddingPart)
}

function createServices(): Services {
  const db = createDb(getCoreEnv().POSTGRES_URL)
  let ai: AiProvider | null = null
  let reranker: Reranker | null | undefined
  let vision: VisionModel | null | undefined
  let transcriber: Transcriber | null | undefined
  let speech: SpeechSynthesizer | null | undefined
  let email: EmailSender | null | undefined
  let connectors: ConnectorRegistry | null = null
  const getAi = () => (ai ??= createAiProvider(getChatBackend(), getEmbeddingBackend(), getFastChatModel()))
  const getVision = () => {
    if (vision !== undefined) return vision
    const backend = getVisionBackend()
    vision = !backend
      ? null
      : backend.provider === 'gemini'
        ? createGeminiVision({ apiKey: backend.apiKey, model: backend.model })
        : createOpenAiCompatibleVision(compatible(backend))
    return vision
  }
  return {
    db,
    repos: createRepositories(db),
    ai: getAi,
    reranker: () => {
      if (reranker !== undefined) return reranker
      const config = getRerankerConfig()
      reranker = config.kind === 'cohere' ? createCohereReranker({ apiKey: config.apiKey, model: config.model }) : config.kind === 'llm' ? createLlmReranker(getAi()) : null
      return reranker
    },
    vision: getVision,
    transcriber: () => {
      if (transcriber !== undefined) return transcriber
      const backend = getTranscriptionBackend()
      transcriber = !backend
        ? null
        : backend.provider === 'gemini'
          ? createGeminiTranscriber({ apiKey: backend.apiKey, model: backend.model })
          : createOpenAiCompatibleTranscriber(compatible(backend))
      return transcriber
    },
    speech: () => {
      if (speech !== undefined) return speech
      const backend = getSpeechBackend()
      speech = !backend
        ? null
        : backend.provider === 'gemini'
          ? createGeminiSpeech({ apiKey: backend.apiKey, model: backend.model, voices: backend.voices ?? DEFAULT_GEMINI_VOICES })
          : createOpenAiCompatibleSpeech({ ...compatible(backend), voices: backend.voices ?? ['af_heart', 'am_michael'] })
      return speech
    },
    ocr: () => {
      const config = getOcrConfig()
      if (!config) return null
      if (config.engine === 'tesseract') return createTesseractOcr({ languages: config.languages })
      const model = getVision()
      return model ? createVisionOcr(model) : null
    },
    connectors: () => (connectors ??= createConnectorRegistry({ google: getOAuthClient('google') })),
    email: () => (email === undefined ? (email = createEmailSender(getEmailConfig())) : email),
  }
}

/** Model calls are metered into the services' database (server/ai/usage.ts). */
function meterInto(services: Services | null) {
  setUsageSink(services ? (entry) => services.repos.usage.record(entry) : null)
}

export function getServices(): Services {
  if (!instance) {
    instance = createServices()
    meterInto(instance)
  }
  return instance
}

export function setServicesForTests(services: Services | null) {
  instance = services
  meterInto(services)
}
