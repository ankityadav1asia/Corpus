/** Workspaces, members, notebooks (collections), settings, models and the audit log. */
import { z } from 'zod'

import { LIMITS, type Role } from '@/lib/constants'

import type { SessionUser } from './auth'
import { email, id, requiredText, role } from './fields'

// ---------- Workspace settings (stored as JSON, always parsed through this schema) ----------

export const workspaceSettingsSchema = z.object({
  retrieval: z
    .object({
      /** Re-rank the fused candidates before they reach the model. */
      rerank: z.boolean().default(true),
      /** Candidates handed to the re-ranker (top N). */
      candidatePool: z.number().int().min(5).max(50).default(20),
      /** Passages kept after re-ranking (top K). */
      topK: z.number().int().min(1).max(10).default(5),
      /** Query variations generated in deep mode. */
      multiQueryCount: z.number().int().min(3).max(5).default(4),
      stepBack: z.boolean().default(true),
      hyde: z.boolean().default(true),
    })
    .prefault({}),
  guardrail: z
    .object({
      enabled: z.boolean().default(true),
      /** Minimum re-ranker relevance (0–1) of the best passage. */
      minRelevance: z.number().min(0).max(1).default(0.35),
      /** Minimum cosine similarity, used when no re-ranker score is available. */
      minSimilarity: z.number().min(0).max(1).default(0.45),
    })
    .prefault({}),
  evaluation: z
    .object({
      enabled: z.boolean().default(true),
      /** Share of answers scored in the background (1 = all). */
      sampleRate: z.number().min(0).max(1).default(1),
    })
    .prefault({}),
})
export type WorkspaceSettings = z.output<typeof workspaceSettingsSchema>

export const workspaceSettingsPatchSchema = z.object({
  retrieval: z
    .object({
      rerank: z.boolean(),
      candidatePool: z.number().int().min(5).max(50),
      topK: z.number().int().min(1).max(10),
      multiQueryCount: z.number().int().min(3).max(5),
      stepBack: z.boolean(),
      hyde: z.boolean(),
    })
    .partial()
    .optional(),
  guardrail: z
    .object({ enabled: z.boolean(), minRelevance: z.number().min(0).max(1), minSimilarity: z.number().min(0).max(1) })
    .partial()
    .optional(),
  evaluation: z
    .object({ enabled: z.boolean(), sampleRate: z.number().min(0).max(1) })
    .partial()
    .optional(),
})
export type WorkspaceSettingsPatch = z.input<typeof workspaceSettingsPatchSchema>

export const workspaceCreateSchema = z.object({ name: requiredText(LIMITS.workspaceNameChars) })
export const workspaceUpdateSchema = z
  .object({ name: requiredText(LIMITS.workspaceNameChars).optional(), settings: workspaceSettingsPatchSchema.optional() })
  .refine((value) => value.name !== undefined || value.settings !== undefined, 'Nothing to update')
export const memberInviteSchema = z.object({ email, role })
export const memberRoleSchema = z.object({ role })
export const collectionRoleSchema = z.object({ userId: id, role: role.nullable() })

export const collectionInputSchema = z.object({ name: requiredText(LIMITS.collectionNameChars) })

export interface WorkspaceSummary {
  id: string
  name: string
  role: Role
  isPersonal: boolean
  memberCount: number
  createdAt: string
}

export interface WorkspaceDetail extends WorkspaceSummary {
  settings: WorkspaceSettings
}

export interface WorkspaceMember {
  userId: string
  email: string
  name: string | null
  role: Role
  joinedAt: string
}

export interface WorkspaceInvite {
  email: string
  role: Role
  createdAt: string
}

export interface CollectionRoleEntry {
  userId: string
  email: string
  name: string | null
  workspaceRole: Role
  override: Role | null
  effectiveRole: Role
}

export interface Collection {
  id: string
  name: string
  documentCount: number
  chunkCount: number
  createdAt: string
  /** The caller's effective role on this notebook. */
  myRole: Role
}

export interface StatsResponse {
  user: SessionUser
  schema: { ready: boolean; version: number; expected: number }
  features: {
    ai: boolean
    emailOtp: boolean
    google: boolean
    github: boolean
    reranker: 'cohere' | 'llm' | 'none'
    images: boolean
    ocr: 'tesseract' | 'vision' | null
    vision: boolean
    transcription: boolean
    audio: boolean
    connectors: { googleDrive: boolean }
  }
  totals: { collections: number; documents: number; chunks: number }
}

export interface AuditEvent {
  id: string
  action: string
  targetType: string | null
  targetId: string | null
  details: Record<string, unknown>
  actorEmail: string | null
  createdAt: string
}

export interface ModelInfo {
  provider: string
  model: string
}

/** Which model does what, and whether stored vectors match the active embedding model. */
export interface ModelsStatus {
  models: {
    chat: ModelInfo | null
    /** Helper calls (re-ranking, planning, judging, follow-ups). */
    fast: ModelInfo | null
    embeddings: ModelInfo | null
    vision: ModelInfo | null
    transcription: ModelInfo | null
    speech: ModelInfo | null
    ocr: ModelInfo | null
    image: ModelInfo | null
  }
  embeddings: { active: string | null; total: number; stale: number; reembedding: boolean }
}
