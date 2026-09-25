import type { Collection, ConversationSummary, ImageSummary, ReportSummary, StatsResponse, WorkspaceSummary } from '@/lib/contracts'

/** Which server features are usable; assumed ready until the first overview arrives. */
export function readFeatures(stats: StatsResponse | undefined) {
  return {
    schema: stats?.schema.ready ?? true,
    ai: stats?.features.ai ?? true,
    images: stats?.features.images ?? false,
    audio: stats?.features.audio ?? false,
  }
}

/** The notebook chat searches ('all' = every notebook), how the header names it, and its passage count. */
export function describeScope(collections: readonly Collection[], selected: string, stats: StatsResponse | undefined) {
  const scope = collections.find((c) => c.id === selected) ?? null
  return {
    scope,
    scopeLabel: scope ? `“${scope.name}”` : 'all notebooks',
    chunkCount: scope ? scope.chunkCount : (stats?.totals.chunks ?? 0),
  }
}

/** How far the getting-started checklist has come. */
export function onboardingProgress(data: {
  stats: StatsResponse | undefined
  conversations: readonly ConversationSummary[]
  reports: readonly ReportSummary[] | undefined
  images: readonly ImageSummary[] | undefined
  workspaces: readonly WorkspaceSummary[]
}) {
  return {
    hasDocuments: (data.stats?.totals.documents ?? 0) > 0,
    hasConversations: data.conversations.length > 0,
    hasReports: (data.reports ?? []).some((report) => report.status !== 'failed'),
    hasImages: (data.images ?? []).some((image) => image.status !== 'failed'),
    hasTeam: data.workspaces.some((item) => !item.isPersonal && item.memberCount > 1),
  }
}
