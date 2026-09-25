/**
 * Limits and constants shared by the browser and the server.
 * Server code enforces every limit; the client uses them only for early feedback.
 */

import type { ConnectorProvider } from '@/lib/contracts'

export const LIMITS = {
  chatMessageChars: 4_000,
  workspaceNameChars: 80,
  collectionNameChars: 80,
  conversationTitleChars: 200,
  documentTitleChars: 200,
  /** Characters of extracted text accepted for one document (~1 MB of text). */
  documentChars: 1_000_000,
  /** Hard cap on chunks (= embedding calls) per document, to bound AI spend. */
  chunksPerDocument: 2_000,
  /** Max length of a chunk written by hand in the chunk editor. */
  chunkChars: 4_000,
  labelChars: 40,
  labelsPerChunk: 20,
  metadataKeysPerChunk: 30,
  metadataValueChars: 500,
  fileBytes: 50 * 1024 * 1024,
  /** Per request: one maximum-size file plus multipart overhead. The UI uploads files one at a time. */
  uploadBytes: 51 * 1024 * 1024,
  filesPerUpload: 10,
  urlChars: 2_048,
  explorerSearchChars: 200,
  reportInstructionsChars: 2_000,
  documentsPerReport: 12,
  evalQuestionChars: 1_000,
  evalReferenceChars: 4_000,
  evalCasesPerWorkspace: 200,
  imagePromptChars: 1_000,
  /** Largest generated image that is stored. */
  imageBytes: 12 * 1024 * 1024,
  imagesPerWorkspace: 500,
  documentsPerImage: 5,
  feedbackCommentChars: 1_000,
  /** Scanned PDF pages read with OCR per document. */
  ocrPages: 300,
} as const

export const TEXT_FILE_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml', '.log', '.pdf'] as const
/** Read with OCR + a vision model. */
export const IMAGE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const
/** Transcribed. */
export const AUDIO_FILE_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'] as const
export const VIDEO_FILE_EXTENSIONS = ['.mp4', '.mov', '.webm'] as const

export const ACCEPTED_FILE_EXTENSIONS = [...TEXT_FILE_EXTENSIONS, ...IMAGE_FILE_EXTENSIONS, ...AUDIO_FILE_EXTENSIONS, ...VIDEO_FILE_EXTENSIONS] as const

export const ACCEPTED_FILE_TYPES = ACCEPTED_FILE_EXTENSIONS.join(',')

/** Dimension of gemini-embedding-001 vectors; the `chunks.embedding` column is typed to match. */
export const EMBEDDING_DIMENSIONS = 3072

/** Views of the workspace shell, in navigation-rail order; notification links point at them. */
/** How connected apps are named in the UI, notifications and sync messages. */
export const CONNECTOR_LABELS: Record<ConnectorProvider, string> = { google_drive: 'Google Drive', notion: 'Notion', github: 'GitHub', website: 'Website' }

export const WORKSPACE_TABS = ['chat', 'reports', 'audio', 'mindmaps', 'images', 'explorer', 'analytics'] as const
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number]

export const CHAT_MODES = ['standard', 'deep'] as const
export type ChatMode = (typeof CHAT_MODES)[number]

/** Workspace / notebook roles, weakest first. */
export const ROLES = ['viewer', 'editor', 'admin'] as const
export type Role = (typeof ROLES)[number]

export const REPORT_TEMPLATES = ['executive_summary', 'comparison_table', 'slide_outline'] as const
export type ReportTemplate = (typeof REPORT_TEMPLATES)[number]

/** Visual styles for knowledge-grounded image generation. */
export const IMAGE_STYLES = ['infographic', 'diagram', 'illustration', 'photo', 'sketch', 'render3d'] as const
export type ImageStyle = (typeof IMAGE_STYLES)[number]

export const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number]

/** NotebookLM-style audio overviews: a conversation between two hosts about the selected sources. */
export const AUDIO_FORMATS = ['deep_dive', 'brief', 'critique', 'debate'] as const
export type AudioFormat = (typeof AUDIO_FORMATS)[number]

export const AUDIO_LENGTHS = ['short', 'default', 'long'] as const
export type AudioLength = (typeof AUDIO_LENGTHS)[number]

export const AUDIO_LANGUAGES = [
  'English',
  'Hindi',
  'Hinglish',
  'Spanish',
  'French',
  'German',
  'Portuguese',
  'Italian',
  'Japanese',
  'Korean',
  'Chinese',
  'Arabic',
  'Bengali',
  'Tamil',
  'Telugu',
  'Marathi',
] as const
export type AudioLanguage = (typeof AUDIO_LANGUAGES)[number]

export const STUDIO_LIMITS = {
  focusChars: 500,
  collectionsPerItem: 20,
  documentsPerItem: 12,
  audioPerWorkspace: 200,
  mindMapsPerWorkspace: 300,
  mindMapNodes: 80,
  mindMapDepth: 4,
} as const

/** Exact wording required by the product spec when retrieval finds nothing relevant enough. */
export const INSUFFICIENT_CONTEXT_MESSAGE = 'Insufficient context in knowledge base.'
