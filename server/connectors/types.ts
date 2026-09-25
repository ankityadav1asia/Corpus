import type { ConnectorBrowseResult, ConnectorKind, ConnectorProvider } from '@/lib/contracts'

/**
 * A connector turns an external app into notebook sources. Every provider implements the same small
 * interface; the sync engine (server/connectors/sync.ts) does the rest — change detection, indexing,
 * removing deleted items — identically for all of them.
 */

/** One importable item found while listing a source for sync. */
export interface SyncItem {
  externalId: string
  /** Changes whenever the content changes (modified time, blob sha, …); null when unknown before fetching. */
  version: string | null
  title: string
  url: string | null
  /** Provider-specific details the fetch step needs (mime type, path, …). */
  meta?: Record<string, string>
}

/** Content fetched for one item: text to index directly, or a file for the normal upload pipeline. */
export type FetchedItem =
  | { type: 'text'; title: string; text: string; url: string | null; version: string | null }
  | { type: 'file'; title: string; fileName: string; data: Uint8Array; url: string | null; version: string | null }

export interface SourceSpec {
  externalId: string
  kind: ConnectorKind
  name: string
  options: { path?: string; maxPages?: number }
}

export interface ConnectorContext {
  /** Decrypted credentials of the connection (empty for websites). */
  credentials: Record<string, string>
  fetch: typeof fetch
  /** Persist refreshed credentials (e.g. a new OAuth access token). */
  saveCredentials: (credentials: Record<string, string>) => Promise<void>
}

export interface Connector {
  readonly id: ConnectorProvider
  browse(context: ConnectorContext, input: { parentId: string | null; query: string | null; cursor: string | null }): Promise<ConnectorBrowseResult>
  /** Everything in the source that should be in the notebook (bounded). */
  list(context: ConnectorContext, source: SourceSpec, limit: number): Promise<SyncItem[]>
  fetchItem(context: ConnectorContext, item: SyncItem, source: SourceSpec): Promise<FetchedItem>
}

/** A failed call to an external app. `auth` = the credentials no longer work (the owner must reconnect). */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryable = false,
    readonly auth = false,
  ) {
    super(message)
    this.name = 'ConnectorError'
  }
}

/** Maps an HTTP failure of an external API to a ConnectorError (no response body: it can contain data). */
export function connectorHttpError(app: string, response: Response): ConnectorError {
  const status = response.status
  if (status === 401 || status === 403) return new ConnectorError(`${app} refused access (${status}). Reconnect the account or check its permissions.`, status, false, true)
  if (status === 404) return new ConnectorError(`${app} could not find this item (404). It may have been deleted or unshared.`, status)
  return new ConnectorError(`${app} request failed (${status})`, status, status === 429 || status >= 500)
}

export async function fetchJson<T>(context: ConnectorContext, app: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await request(context, app, url, init)
  return (await response.json()) as T
}

export async function request(context: ConnectorContext, app: string, url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response
  try {
    response = await context.fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000), redirect: 'follow' })
  } catch {
    throw new ConnectorError(`${app} could not be reached`, null, true)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw connectorHttpError(app, response)
  }
  return response
}
