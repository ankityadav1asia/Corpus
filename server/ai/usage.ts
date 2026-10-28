import { AsyncLocalStorage } from 'node:async_hooks'

import { log } from '@/server/logger'

/**
 * AI usage metering. Every model call reports its tokens here; the workspace, member and feature
 * come from the scope of the request or background job that made the call (AsyncLocalStorage), so
 * the providers do not need to know who they work for. Rows feed the usage dashboard
 * (GET /api/usage). Recording is best-effort: a failed insert is logged and never fails the call.
 */

export interface UsageScope {
  workspaceId: string | null
  userId: string | null
  /** What the call served: a job type ("generate_report"), or the API area of a request ("corpus"). */
  feature: string
}

export interface UsageReport {
  model: string
  kind: 'generate' | 'embed'
  inputTokens: number
  outputTokens: number
  /** True when the vendor did not count the tokens and they were estimated from the text. */
  estimated: boolean
}

export type UsageEntry = UsageScope & UsageReport & { workspaceId: string }

const scopes = new AsyncLocalStorage<UsageScope>()
let sink: ((entry: UsageEntry) => Promise<void>) | null = null

/** Where usage rows go (the composition root passes the repository; tests pass a spy). */
export function setUsageSink(next: ((entry: UsageEntry) => Promise<void>) | null) {
  sink = next
}

/** Runs `run` with calls attributed to `scope` (fields not given are kept from the outer scope). */
export function withUsageScope<T>(scope: Partial<UsageScope>, run: () => T): T {
  const outer = scopes.getStore()
  return scopes.run({ workspaceId: null, userId: null, feature: 'other', ...outer, ...scope }, run)
}

/** Records one model call. Calls outside a workspace (sign-in checks, scripts) are not metered. */
export async function recordUsage(report: UsageReport): Promise<void> {
  const scope = scopes.getStore()
  if (!sink || !scope?.workspaceId) return
  const tokens = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
  try {
    await sink({ ...scope, workspaceId: scope.workspaceId, ...report, inputTokens: tokens(report.inputTokens), outputTokens: tokens(report.outputTokens) })
  } catch (error) {
    log.warn('Could not record AI usage', { feature: scope.feature, error: String(error) })
  }
}

/** About four characters per token for the languages this app serves; used when a vendor does not count. */
export function estimateTokens(texts: readonly string[]): number {
  return Math.ceil(texts.reduce((total, text) => total + text.length, 0) / 4)
}
