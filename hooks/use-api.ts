'use client'

import useSWR, { type SWRConfiguration } from 'swr'

import { useActiveWorkspaceId } from '@/components/workspace-provider'
import { ApiError, apiJson, swrFetcher, workspaceFetcher } from '@/lib/api-client'
import type {
  AnalyticsResponse,
  AudioDetail,
  AudioSummary,
  AuditEvent,
  ChunkDetail,
  ChunkPage,
  Collection,
  CollectionRoleEntry,
  ConnectorsOverview,
  ConversationSummary,
  DocumentDetail,
  DocumentSummary,
  EvalCase,
  EvalRunSummary,
  MindMapDetail,
  MindMapSummary,
  ModelsStatus,
  NotificationItem,
  QualitySummary,
  ReportDetail,
  ReportSummary,
  StatsResponse,
  UsageSummary,
  WorkspaceDetail,
  WorkspaceInvite,
  WorkspaceMember,
} from '@/lib/contracts'

/**
 * Server state lives in SWR caches (deduped, revalidated) instead of hand-rolled useState + fetch.
 * Every key includes the active workspace, so data from one workspace never shows in another.
 */

const options: SWRConfiguration = {
  // Retrying cannot fix a 4xx (validation, auth, not found) — only transient server errors.
  shouldRetryOnError: (error: unknown) => !(error instanceof ApiError && error.status < 500),
  errorRetryCount: 3,
}

function useWorkspaceSWR<T>(path: string | null, config: SWRConfiguration<T> = {}) {
  const workspaceId = useActiveWorkspaceId()
  return useSWR<T>(path && workspaceId ? ([path, workspaceId] as const) : null, workspaceFetcher, { ...options, ...config })
}

/** Polls while background work (reports, benchmark runs) is still going. */
const whileActive =
  <T>(isActive: (data: T) => boolean, intervalMs = 3000) =>
  (data: T | undefined) =>
    data && isActive(data) ? intervalMs : 0

const isRunning = (status: string) => status === 'queued' || status === 'running'

let lastNudge = 0

/**
 * Reports and mind maps are queued by the Go API, which cannot run the TypeScript job runner: while
 * one is still being written, each poll asks the runner to keep going (at most once per 2 s).
 */
function nudgeJobs() {
  const now = Date.now()
  if (now - lastNudge < 2000) return
  lastNudge = now
  apiJson('/api/jobs/nudge', { method: 'POST', workspaceId: null }).catch(() => undefined)
}

const nudgeWhile =
  <T>(isActive: (data: T) => boolean) =>
  (data: T) => {
    if (isActive(data)) nudgeJobs()
  }

export function useCollections() {
  return useWorkspaceSWR<{ collections: Collection[] }>('/api/collections')
}

export function useConversations() {
  return useWorkspaceSWR<{ conversations: ConversationSummary[] }>('/api/conversations')
}

/** Server-side history search (titles and message text), so chats older than the sidebar list are found too. */
export function useConversationSearch(query: string) {
  const q = query.trim()
  return useWorkspaceSWR<{ conversations: ConversationSummary[] }>(q ? `/api/conversations?q=${encodeURIComponent(q)}` : null, { keepPreviousData: true })
}

/** Polls while any document is still being indexed, so progress and status update live. */
export function useDocuments(collectionId: string | null) {
  return useWorkspaceSWR<{ documents: DocumentSummary[] }>(collectionId ? `/api/corpus?collectionId=${encodeURIComponent(collectionId)}` : null, {
    refreshInterval: whileActive((data: { documents: DocumentSummary[] }) => data.documents.some((document) => document.status === 'processing'), 2500),
  })
}

export function useDocumentDetail(documentId: string | null) {
  return useWorkspaceSWR<DocumentDetail>(documentId ? `/api/corpus/documents/${documentId}` : null)
}

/** Loads even before a workspace is known: it also reports whether the schema is migrated. */
export function useStats() {
  const workspaceId = useActiveWorkspaceId()
  return useSWR<StatsResponse>(
    ['/api/stats', workspaceId ?? ''] as const,
    ([path, workspace]: readonly [string, string]) => apiJson<StatsResponse>(path, { workspaceId: workspace || null }),
    options,
  )
}

export function useAnalytics(scope: 'me' | 'workspace') {
  return useWorkspaceSWR<AnalyticsResponse>(`/api/analytics?scope=${scope}`)
}

/** AI tokens, questions, storage and studio items of the workspace (admins; null skips the request). */
export function useUsage(days: number | null) {
  return useWorkspaceSWR<UsageSummary>(days ? `/api/usage?days=${days}` : null)
}

export function useChunks(params: { collectionId: string | null; label: string; q: string; page: number; pageSize: number }) {
  const search = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  if (params.collectionId) search.set('collectionId', params.collectionId)
  if (params.label) search.set('label', params.label)
  if (params.q) search.set('q', params.q)
  return useWorkspaceSWR<ChunkPage>(`/api/corpus/chunks?${search.toString()}`, { keepPreviousData: true })
}

export function useChunkDetail(chunkId: string | null) {
  return useWorkspaceSWR<{ chunk: ChunkDetail }>(chunkId ? `/api/corpus/chunks/${chunkId}` : null)
}

export function useWorkspaceDetail(workspaceId: string | null) {
  return useWorkspaceSWR<{ workspace: WorkspaceDetail }>(workspaceId ? `/api/workspaces/${workspaceId}` : null)
}

export function useMembers(workspaceId: string | null) {
  return useWorkspaceSWR<{ members: WorkspaceMember[]; invites: WorkspaceInvite[] }>(workspaceId ? `/api/workspaces/${workspaceId}/members` : null)
}

export function useCollectionRoles(collectionId: string | null) {
  return useWorkspaceSWR<{ roles: CollectionRoleEntry[] }>(collectionId ? `/api/collections/${collectionId}/roles` : null)
}

export function useReports() {
  const active = (data: { reports: ReportSummary[] }) => data.reports.some((report) => isRunning(report.status))
  return useWorkspaceSWR<{ reports: ReportSummary[] }>('/api/reports', { refreshInterval: whileActive(active), onSuccess: nudgeWhile(active) })
}

export function useReport(reportId: string | null) {
  const active = (data: { report: ReportDetail }) => isRunning(data.report.status)
  return useWorkspaceSWR<{ report: ReportDetail }>(reportId ? `/api/reports/${reportId}` : null, {
    refreshInterval: whileActive(active, 2000),
    onSuccess: nudgeWhile(active),
  })
}

export function useQuality(days: number) {
  return useWorkspaceSWR<QualitySummary>(`/api/evaluations?days=${days}`)
}

export function useEvalCases() {
  return useWorkspaceSWR<{ cases: EvalCase[] }>('/api/evaluations/cases')
}

export function useEvalRuns() {
  return useWorkspaceSWR<{ runs: EvalRunSummary[] }>('/api/evaluations/runs', {
    refreshInterval: whileActive((data: { runs: EvalRunSummary[] }) => data.runs.some((run) => isRunning(run.status))),
  })
}

export function useAudit(workspaceId: string | null) {
  return useWorkspaceSWR<{ events: AuditEvent[] }>(workspaceId ? `/api/workspaces/${workspaceId}/audit` : null)
}

/** Across all workspaces; refreshed every 30 s and when the tab regains focus. */
export function useNotifications() {
  return useSWR<{ items: NotificationItem[]; unread: number }>('/api/notifications', swrFetcher, { ...options, refreshInterval: 30_000 })
}

export function useAudioOverviews() {
  return useWorkspaceSWR<{ overviews: AudioSummary[] }>('/api/audio', {
    refreshInterval: whileActive((data: { overviews: AudioSummary[] }) => data.overviews.some((item) => isRunning(item.status)), 3000),
  })
}

export function useAudioOverview(id: string | null) {
  return useWorkspaceSWR<{ overview: AudioDetail }>(id ? `/api/audio/${id}` : null, {
    refreshInterval: whileActive((data: { overview: AudioDetail }) => isRunning(data.overview.status), 2500),
  })
}

export function useMindMaps() {
  const active = (data: { mindMaps: MindMapSummary[] }) => data.mindMaps.some((item) => isRunning(item.status))
  return useWorkspaceSWR<{ mindMaps: MindMapSummary[] }>('/api/mindmaps', { refreshInterval: whileActive(active, 2500), onSuccess: nudgeWhile(active) })
}

export function useMindMap(id: string | null) {
  const active = (data: { mindMap: MindMapDetail }) => isRunning(data.mindMap.status)
  return useWorkspaceSWR<{ mindMap: MindMapDetail }>(id ? `/api/mindmaps/${id}` : null, {
    refreshInterval: whileActive(active, 2000),
    onSuccess: nudgeWhile(active),
  })
}

/** Connected apps and synced sources; polls while a sync is queued or running. */
export function useConnectors() {
  return useWorkspaceSWR<ConnectorsOverview>('/api/connectors', {
    refreshInterval: whileActive((data: ConnectorsOverview) => data.sources.some((source) => source.status === 'queued' || source.status === 'syncing'), 3000),
  })
}

export function useModelsStatus(workspaceId: string | null) {
  return useWorkspaceSWR<ModelsStatus>(workspaceId ? `/api/workspaces/${workspaceId}/models` : null, {
    refreshInterval: whileActive((data: ModelsStatus) => data.embeddings.reembedding, 4000),
  })
}
