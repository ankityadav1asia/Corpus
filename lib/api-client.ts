import type { ApiErrorBody } from '@/lib/contracts'

/** Browser-side API access. Every component goes through here instead of ad-hoc fetch calls. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Sent with every request so the server can scope and authorize it (see server/http/route.ts). */
export const WORKSPACE_HEADER = 'X-Workspace-Id'

let activeWorkspaceId: string | null = null

/** Called by WorkspaceProvider whenever the active workspace changes. */
export function setActiveWorkspaceId(id: string | null) {
  activeWorkspaceId = id
}

export function getActiveWorkspaceId(): string | null {
  return activeWorkspaceId
}

const sessionExpiredListeners = new Set<() => void>()

/** For requests made outside apiFetch (e.g. XHR uploads with progress). */
export function notifySessionExpired() {
  sessionExpiredListeners.forEach((listener) => listener())
}

/** Fired on any 401 so the UI can ask the user to sign in again. */
export function onSessionExpired(listener: () => void) {
  sessionExpiredListeners.add(listener)
  return () => {
    sessionExpiredListeners.delete(listener)
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>
    if (body.error?.message) return new ApiError(res.status, body.error.code ?? `HTTP_${res.status}`, body.error.message, body.error.details)
  } catch {
    // not JSON
  }
  return new ApiError(res.status, `HTTP_${res.status}`, res.status >= 500 ? 'The server had a problem. Please try again.' : 'Request failed.')
}

export interface ApiOptions {
  /** Statuses that should be returned instead of thrown (e.g. 422 with per-file reasons). */
  allowStatus?: number[]
  /** Overrides the active workspace (SWR keys carry it explicitly); null sends none. */
  workspaceId?: string | null
}

export async function apiFetch(path: string, init: RequestInit = {}, options: ApiOptions = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const workspaceId = options.workspaceId === undefined ? activeWorkspaceId : options.workspaceId
  if (workspaceId && !headers.has(WORKSPACE_HEADER)) headers.set(WORKSPACE_HEADER, workspaceId)
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers })
  if (res.status === 401) notifySessionExpired()
  if (!res.ok && !options.allowStatus?.includes(res.status)) throw await toApiError(res)
  return res
}

export async function apiJson<T>(path: string, init: RequestInit & { json?: unknown; workspaceId?: string | null } = {}): Promise<T> {
  const { json, headers, body, workspaceId, ...rest } = init
  const merged = new Headers(headers)
  if (json !== undefined) merged.set('Content-Type', 'application/json')
  const res = await apiFetch(path, { ...rest, headers: merged, body: json !== undefined ? JSON.stringify(json) : body }, { workspaceId })
  return (await res.json()) as T
}

/** For endpoints that are not workspace-scoped (e.g. the workspace list itself). */
export const swrFetcher = <T>(path: string) => apiJson<T>(path, { workspaceId: null })

/** SWR key [path, workspaceId]: switching workspaces never shows another workspace's cached data. */
export const workspaceFetcher = <T>([path, workspaceId]: readonly [string, string]) => apiJson<T>(path, { workspaceId })

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong.'
}

/** Only http(s) links are ever rendered as clickable sources. */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}
