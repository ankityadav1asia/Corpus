import 'server-only'

import { z } from 'zod'

import { AppError, Errors } from '@/server/http/errors'
import type { SecretKeys } from '@/server/security/keys'

/** Treat unset, empty and whitespace-only variables the same way. */
const optionalString = z.preprocess((value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined), z.string().optional())

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  POSTGRES_URL: optionalString,
  AUTH_SECRET: optionalString,
  /** The previous AUTH_SECRET while rotating: still accepted for sessions and sealed secrets. */
  AUTH_SECRET_PREVIOUS: optionalString,
  APP_URL: optionalString,
  AUTH_ALLOWED_EMAILS: optionalString,
  AUTH_ALLOWED_DOMAINS: optionalString,
  GOOGLE_API_KEY: optionalString,
  GEMINI_API_KEY: optionalString,
  GEMINI_CHAT_MODEL: optionalString,
  /** Optional smaller model for helper calls (re-ranking, query planning, judging, follow-ups). */
  GEMINI_FAST_MODEL: optionalString,
  OPENAI_COMPATIBLE_FAST_MODEL: optionalString,
  GEMINI_EMBEDDING_MODEL: optionalString,
  GEMINI_IMAGE_MODEL: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  RESEND_API_KEY: optionalString,
  RESEND_FROM_EMAIL: optionalString,
  SMTP_HOST: optionalString,
  SMTP_PORT: optionalString,
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  GMAIL_USER: optionalString,
  GMAIL_APP_PASSWORD: optionalString,
  RERANKER: optionalString,
  COHERE_API_KEY: optionalString,
  COHERE_RERANK_MODEL: optionalString,
  CRON_SECRET: optionalString,
  /** false when a dedicated worker (npm run worker) processes the job queue; see webRunsJobs. */
  WEB_RUNS_JOBS: optionalString,
  /** Number of trusted reverse proxies that append to X-Forwarded-For (1 or true for one). */
  TRUST_PROXY: optionalString,
  // Set by Vercel on every deployment (system environment variables).
  VERCEL: optionalString,
  VERCEL_ENV: optionalString,
  VERCEL_URL: optionalString,
  VERCEL_BRANCH_URL: optionalString,
  VERCEL_PROJECT_PRODUCTION_URL: optionalString,
  // Model back ends: 'gemini' (default) or 'openai-compatible' (Ollama, vLLM, LM Studio, LocalAI, Groq …).
  CHAT_PROVIDER: optionalString,
  EMBEDDING_PROVIDER: optionalString,
  OPENAI_COMPATIBLE_BASE_URL: optionalString,
  OPENAI_COMPATIBLE_API_KEY: optionalString,
  OPENAI_COMPATIBLE_CHAT_MODEL: optionalString,
  OPENAI_COMPATIBLE_EMBEDDING_MODEL: optionalString,
  OPENAI_COMPATIBLE_EMBEDDING_BASE_URL: optionalString,
  // Multimodal: reading images, transcribing audio/video, speech for audio overviews, OCR.
  VISION_PROVIDER: optionalString,
  GEMINI_VISION_MODEL: optionalString,
  OPENAI_COMPATIBLE_VISION_MODEL: optionalString,
  TRANSCRIPTION_PROVIDER: optionalString,
  GEMINI_TRANSCRIPTION_MODEL: optionalString,
  OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL: optionalString,
  OPENAI_COMPATIBLE_TRANSCRIPTION_BASE_URL: optionalString,
  TTS_PROVIDER: optionalString,
  GEMINI_TTS_MODEL: optionalString,
  GEMINI_TTS_VOICES: optionalString,
  OPENAI_COMPATIBLE_TTS_MODEL: optionalString,
  OPENAI_COMPATIBLE_TTS_BASE_URL: optionalString,
  OPENAI_COMPATIBLE_TTS_VOICES: optionalString,
  OCR_ENGINE: optionalString,
  OCR_LANGUAGES: optionalString,
})

type RawEnv = z.infer<typeof envSchema>

const DEFAULT_CHAT_MODEL = 'gemini-3.6-flash'
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001'
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image'
const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts'
const MIN_SECRET_LENGTH = 32

let cached: RawEnv | null = null

function raw(): RawEnv {
  cached ??= envSchema.parse(process.env)
  return cached
}

/** Tests mutate process.env and call this to re-read it. */
export function resetEnvCache() {
  cached = null
}

export const isProduction = () => raw().NODE_ENV === 'production'

export interface CoreEnv {
  POSTGRES_URL: string
  AUTH_SECRET: string
}

/** Variables the app cannot run without. Fails closed: no default secrets. */
export function getCoreEnv(): CoreEnv {
  const env = raw()
  const missing: string[] = []
  if (!env.POSTGRES_URL) missing.push('POSTGRES_URL')
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < MIN_SECRET_LENGTH) missing.push(`AUTH_SECRET (min ${MIN_SECRET_LENGTH} chars)`)
  if (missing.length) {
    throw new AppError(503, 'NOT_CONFIGURED', `Server is missing required configuration: ${missing.join(', ')}`)
  }
  return { POSTGRES_URL: env.POSTGRES_URL!, AUTH_SECRET: env.AUTH_SECRET! }
}

/**
 * Key material for signing and sealing: the current AUTH_SECRET first (used to sign and encrypt),
 * then AUTH_SECRET_PREVIOUS during a rotation (still accepted to verify and decrypt). See
 * docs/SECURITY.md → "Rotating AUTH_SECRET".
 */
export function getSecretKeys(): SecretKeys {
  const current = getCoreEnv().AUTH_SECRET
  const previous = raw().AUTH_SECRET_PREVIOUS
  return previous && previous.length >= MIN_SECRET_LENGTH && previous !== current ? [current, previous] : [current]
}

function looksLikePlaceholder(value: string) {
  return value.length < 20 || /\.\.\.|^your[-_]/i.test(value)
}

/** The Gemini API key, or null when none (or a placeholder) is set. */
export function geminiApiKey(): string | null {
  const env = raw()
  const apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY
  return apiKey && !looksLikePlaceholder(apiKey) ? apiKey : null
}

/** Where a model runs. Open-source models are reached through any OpenAI-compatible server. */
export type ModelBackend = { provider: 'gemini'; apiKey: string; model: string } | { provider: 'openai-compatible'; baseUrl: string; apiKey: string | null; model: string }

type Capability = 'chat' | 'embeddings' | 'vision' | 'transcription' | 'speech'

const CAPABILITY_LABEL: Record<Capability, string> = {
  chat: 'CHAT_PROVIDER',
  embeddings: 'EMBEDDING_PROVIDER',
  vision: 'VISION_PROVIDER',
  transcription: 'TRANSCRIPTION_PROVIDER',
  speech: 'TTS_PROVIDER',
}

function providerChoice(value: string | undefined, fallback: string): string {
  return (value ?? fallback).toLowerCase()
}

function compatibleBaseUrl(override: string | undefined, capability: Capability): string {
  const baseUrl = override ?? raw().OPENAI_COMPATIBLE_BASE_URL
  if (!baseUrl) throw Errors.notConfigured(`${CAPABILITY_LABEL[capability]}=openai-compatible requires OPENAI_COMPATIBLE_BASE_URL (e.g. http://localhost:11434/v1 for Ollama).`)
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
  } catch {
    throw Errors.notConfigured(`The base URL for ${CAPABILITY_LABEL[capability]} is not a valid http(s) URL.`)
  }
  return baseUrl
}

function geminiBackend(model: string, capability: Capability): ModelBackend {
  const apiKey = geminiApiKey()
  if (!apiKey)
    throw Errors.notConfigured(`AI is not configured. Set GOOGLE_API_KEY on the server, or ${CAPABILITY_LABEL[capability]}=openai-compatible for an open-source model server.`)
  return { provider: 'gemini', apiKey, model }
}

function compatibleBackend(model: string | undefined, modelVariable: string, capability: Capability, baseUrlOverride?: string): ModelBackend {
  if (!model) throw Errors.notConfigured(`${CAPABILITY_LABEL[capability]}=openai-compatible requires ${modelVariable}.`)
  return { provider: 'openai-compatible', baseUrl: compatibleBaseUrl(baseUrlOverride, capability), apiKey: raw().OPENAI_COMPATIBLE_API_KEY ?? null, model }
}

/** Answers, query planning, re-ranking, judging, reports, briefs, scripts. */
export function getChatBackend(): ModelBackend {
  const env = raw()
  return providerChoice(env.CHAT_PROVIDER, 'gemini') === 'openai-compatible'
    ? compatibleBackend(env.OPENAI_COMPATIBLE_CHAT_MODEL, 'OPENAI_COMPATIBLE_CHAT_MODEL', 'chat')
    : geminiBackend(env.GEMINI_CHAT_MODEL ?? DEFAULT_CHAT_MODEL, 'chat')
}

/** The fast helper model of the chat provider, or null to use the chat model (with thinking off). */
export function getFastChatModel(): string | null {
  const env = raw()
  return providerChoice(env.CHAT_PROVIDER, 'gemini') === 'openai-compatible' ? (env.OPENAI_COMPATIBLE_FAST_MODEL ?? null) : (env.GEMINI_FAST_MODEL ?? null)
}

export function getEmbeddingBackend(): ModelBackend {
  const env = raw()
  return providerChoice(env.EMBEDDING_PROVIDER, 'gemini') === 'openai-compatible'
    ? compatibleBackend(env.OPENAI_COMPATIBLE_EMBEDDING_MODEL, 'OPENAI_COMPATIBLE_EMBEDDING_MODEL', 'embeddings', env.OPENAI_COMPATIBLE_EMBEDDING_BASE_URL)
    : geminiBackend(env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL, 'embeddings')
}

/**
 * Optional capabilities: null when turned off ('none') or not configured. The default follows the
 * chat provider — Gemini models are multimodal; open-source servers need the model named.
 */
function optionalBackend(
  capability: 'vision' | 'transcription',
  options: {
    /** The *_PROVIDER variable: gemini, openai-compatible or none. */
    choice: string | undefined
    geminiModel: string | undefined
    compatibleModel: string | undefined
    /** Named in the error when the open-source model is missing. */
    compatibleVariable: string
    compatibleBaseUrl?: string
  },
): ModelBackend | null {
  const env = raw()
  const { choice, geminiModel, compatibleModel, compatibleVariable, compatibleBaseUrl } = options
  const fallback = geminiApiKey() && providerChoice(env.CHAT_PROVIDER, 'gemini') !== 'openai-compatible' ? 'gemini' : compatibleModel ? 'openai-compatible' : 'none'
  const selected = providerChoice(choice, fallback)
  if (selected === 'none') return null
  try {
    return selected === 'openai-compatible'
      ? compatibleBackend(compatibleModel, compatibleVariable, capability, compatibleBaseUrl)
      : geminiBackend(geminiModel ?? env.GEMINI_CHAT_MODEL ?? DEFAULT_CHAT_MODEL, capability)
  } catch {
    return null
  }
}

export function getVisionBackend(): ModelBackend | null {
  const env = raw()
  return optionalBackend('vision', {
    choice: env.VISION_PROVIDER,
    geminiModel: env.GEMINI_VISION_MODEL,
    compatibleModel: env.OPENAI_COMPATIBLE_VISION_MODEL,
    compatibleVariable: 'OPENAI_COMPATIBLE_VISION_MODEL',
  })
}

export function getTranscriptionBackend(): ModelBackend | null {
  const env = raw()
  // Open Gemma models read images but do not accept audio: transcribe with a Gemini model then.
  const chat = env.GEMINI_CHAT_MODEL ?? DEFAULT_CHAT_MODEL
  return optionalBackend('transcription', {
    choice: env.TRANSCRIPTION_PROVIDER,
    geminiModel: env.GEMINI_TRANSCRIPTION_MODEL ?? (/^gemma/i.test(chat) ? DEFAULT_CHAT_MODEL : chat),
    compatibleModel: env.OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL,
    compatibleVariable: 'OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL',
    compatibleBaseUrl: env.OPENAI_COMPATIBLE_TRANSCRIPTION_BASE_URL,
  })
}

function voicePair(value: string | undefined): readonly [string, string] | null {
  const voices = (value ?? '')
    .split(',')
    .map((voice) => voice.trim())
    .filter(Boolean)
  return voices.length >= 2 ? [voices[0]!, voices[1]!] : null
}

export type SpeechBackend = ModelBackend & { voices: readonly [string, string] | null }

/** Text-to-speech for audio overviews (two hosts, two voices). */
export function getSpeechBackend(): SpeechBackend | null {
  const env = raw()
  const fallback = geminiApiKey() ? 'gemini' : env.OPENAI_COMPATIBLE_TTS_MODEL ? 'openai-compatible' : 'none'
  const selected = providerChoice(env.TTS_PROVIDER, fallback)
  if (selected === 'none') return null
  try {
    if (selected === 'openai-compatible') {
      const backend = compatibleBackend(env.OPENAI_COMPATIBLE_TTS_MODEL, 'OPENAI_COMPATIBLE_TTS_MODEL', 'speech', env.OPENAI_COMPATIBLE_TTS_BASE_URL)
      return { ...backend, voices: voicePair(env.OPENAI_COMPATIBLE_TTS_VOICES) ?? ['af_heart', 'am_michael'] }
    }
    return { ...geminiBackend(env.GEMINI_TTS_MODEL ?? DEFAULT_TTS_MODEL, 'speech'), voices: voicePair(env.GEMINI_TTS_VOICES) }
  } catch {
    return null
  }
}

export type OcrConfig = { engine: 'tesseract'; languages: string } | { engine: 'vision' } | null

/**
 * OCR for scanned PDFs and images. Default: Tesseract (open source, runs locally, no quota).
 * OCR_ENGINE=vision uses the vision model instead (better on handwriting and complex layouts).
 */
export function getOcrConfig(): OcrConfig {
  const env = raw()
  const engine = providerChoice(env.OCR_ENGINE, 'tesseract')
  if (engine === 'none') return null
  if (engine === 'vision') return getVisionBackend() ? { engine: 'vision' } : null
  const languages = (env.OCR_LANGUAGES ?? 'eng').replace(/[^a-z_+]/gi, '') || 'eng'
  return { engine: 'tesseract', languages }
}

/** Image generation needs the Gemini key; GEMINI_IMAGE_MODEL=none turns it off. */
export function getImageConfig(): { apiKey: string; model: string } | null {
  const apiKey = geminiApiKey()
  if (!apiKey || !isAiConfigured()) return null
  const model = raw().GEMINI_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL
  if (model.toLowerCase() === 'none') return null
  return { apiKey, model }
}

/** Chat and embeddings both resolve (the minimum for search and answers). */
export function isAiConfigured() {
  try {
    getChatBackend()
    getEmbeddingBackend()
    return true
  } catch {
    return false
  }
}

export type OAuthProviderId = 'google' | 'github'

export function getOAuthClient(provider: OAuthProviderId): { clientId: string; clientSecret: string } | null {
  const env = raw()
  const clientId = provider === 'google' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID
  const clientSecret = provider === 'google' ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

export type EmailConfig = { kind: 'resend'; apiKey: string; from: string } | { kind: 'smtp'; host: string; port: number; user: string; pass: string; from: string }

export function getEmailConfig(): EmailConfig | null {
  const env = raw()
  if (env.RESEND_API_KEY) {
    return { kind: 'resend', apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM_EMAIL ?? 'Corpus <onboarding@resend.dev>' }
  }
  const user = env.SMTP_USER ?? env.GMAIL_USER
  const pass = env.SMTP_PASS ?? env.GMAIL_APP_PASSWORD
  if (user && pass) {
    const host = env.SMTP_HOST ?? (env.GMAIL_USER ? 'smtp.gmail.com' : undefined)
    if (!host) return null
    const port = Number.parseInt(env.SMTP_PORT ?? '465', 10)
    return { kind: 'smtp', host, port: Number.isFinite(port) ? port : 465, user, pass, from: `"Corpus" <${user}>` }
  }
  return null
}

export interface AuthPolicy {
  emails: ReadonlySet<string>
  domains: ReadonlySet<string>
}

function csvSet(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
  )
}

export function getAuthPolicy(): AuthPolicy {
  const env = raw()
  return { emails: csvSet(env.AUTH_ALLOWED_EMAILS), domains: csvSet(env.AUTH_ALLOWED_DOMAINS) }
}

/**
 * Public origin used to build OAuth redirect URIs. APP_URL (or Vercel's own address) is required in
 * production so a spoofed Host header can never influence where the provider sends the authorization code.
 */
export function getAppOrigin(requestUrl: string): string {
  const appUrl = getConfiguredAppUrl()
  if (appUrl) {
    try {
      return new URL(appUrl).origin
    } catch {
      throw Errors.notConfigured('APP_URL is not a valid URL.')
    }
  }
  if (isProduction()) {
    throw new AppError(503, 'APP_URL_MISSING', 'APP_URL must be set in production (e.g. APP_URL=https://your-domain.com).')
  }
  return new URL(requestUrl).origin
}

export function shouldUseSecureCookies() {
  return isProduction() || Boolean(getConfiguredAppUrl()?.startsWith('https://'))
}

export type RerankerConfig = { kind: 'cohere'; apiKey: string; model: string } | { kind: 'llm' } | { kind: 'none' }

/**
 * RERANKER=auto (default) uses Cohere when COHERE_API_KEY is set and the Gemini LLM grader otherwise.
 * RERANKER=cohere|llm|none forces a choice.
 */
export function getRerankerConfig(): RerankerConfig {
  const env = raw()
  const choice = (env.RERANKER ?? 'auto').toLowerCase()
  if (choice === 'none') return { kind: 'none' }
  if (choice === 'llm') return { kind: 'llm' }
  if (env.COHERE_API_KEY && (choice === 'cohere' || choice === 'auto')) {
    return { kind: 'cohere', apiKey: env.COHERE_API_KEY, model: env.COHERE_RERANK_MODEL ?? 'rerank-v3.5' }
  }
  if (choice === 'cohere') throw Errors.notConfigured('RERANKER=cohere requires COHERE_API_KEY.')
  return { kind: 'llm' }
}

/**
 * The public origin as configured, or null (getAppOrigin validates it for redirects): APP_URL, or on
 * Vercel the deployment's own address when APP_URL is unset (the production domain for production
 * deployments, the branch URL for previews). Vercel sets those variables itself, so a request can
 * never influence them.
 */
export function getConfiguredAppUrl(): string | null {
  const env = raw()
  if (env.APP_URL) return env.APP_URL
  if (!env.VERCEL) return null
  const host = env.VERCEL_ENV === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL : (env.VERCEL_BRANCH_URL ?? env.VERCEL_URL)
  return host ? `https://${host}` : null
}

/** Running on Vercel (serverless functions: no long-lived worker, jobs run after responses and on a cron). */
export function isVercel(): boolean {
  return Boolean(raw().VERCEL)
}

const MAX_PROXY_HOPS = 5

/**
 * How many trusted reverse proxies append to X-Forwarded-For; 0 means the header is ignored.
 * TRUST_PROXY=1 (or true) behind one proxy (Render, Railway, Fly), 2 with a CDN in front of it;
 * Vercel counts as 1. A number higher than the real chain lets clients choose their address.
 */
export function trustedProxyHops(): number {
  const env = raw()
  const value = env.TRUST_PROXY?.toLowerCase()
  if (value === 'true') return 1
  if (value && /^[1-9]\d*$/.test(value)) return Math.min(Number(value), MAX_PROXY_HOPS)
  return env.VERCEL ? 1 : 0
}

/**
 * Whether the web server also works through the job queue after responses (default). Set
 * WEB_RUNS_JOBS=false when a dedicated worker runs, so OCR, transcription and audio stay out of
 * the web process and its memory.
 */
export function webRunsJobs(): boolean {
  const value = raw().WEB_RUNS_JOBS?.toLowerCase()
  return value !== 'false' && value !== '0' && value !== 'off'
}

/** Shared secret for the /api/jobs/run endpoint (e.g. a scheduled cron). Disabled when unset. */
export function getCronSecret(): string | null {
  const secret = raw().CRON_SECRET
  return secret && secret.length >= 16 ? secret : null
}

/** Names (never values) of optional features that are not configured; shown to the signed-in user. */
export function getFeatureFlags() {
  const ai = isAiConfigured()
  let reranker: 'cohere' | 'llm' | 'none' = 'none'
  try {
    reranker = ai ? getRerankerConfig().kind : 'none'
  } catch {
    reranker = 'none'
  }
  const ocr = getOcrConfig()
  return {
    ai,
    emailOtp: getEmailConfig() !== null,
    google: getOAuthClient('google') !== null,
    github: getOAuthClient('github') !== null,
    reranker,
    images: getImageConfig() !== null,
    ocr: ocr ? ocr.engine : null,
    vision: getVisionBackend() !== null,
    transcription: getTranscriptionBackend() !== null,
    audio: ai && getSpeechBackend() !== null,
    connectors: { googleDrive: getOAuthClient('google') !== null },
  }
}

function describeBackend(backend: ModelBackend | null): { provider: string; model: string } | null {
  return backend ? { provider: backend.provider, model: backend.model } : null
}

function safely<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    return null
  }
}

/** Which model does what (provider + model names only; never keys or URLs). */
export function getModelSummary() {
  const ocr = getOcrConfig()
  const image = getImageConfig()
  return {
    chat: describeBackend(safely(getChatBackend)),
    fast: (() => {
      const chat = safely(getChatBackend)
      return chat ? { provider: chat.provider, model: getFastChatModel() ?? `${chat.model} (thinking off)` } : null
    })(),
    embeddings: describeBackend(safely(getEmbeddingBackend)),
    vision: describeBackend(getVisionBackend()),
    transcription: describeBackend(getTranscriptionBackend()),
    speech: describeBackend(getSpeechBackend()),
    ocr: ocr ? { provider: ocr.engine, model: ocr.engine === 'tesseract' ? `tesseract (${ocr.languages})` : 'vision model' } : null,
    image: image ? { provider: 'gemini', model: image.model } : null,
  }
}
