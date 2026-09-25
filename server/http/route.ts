import 'server-only'

import { NextResponse, type NextRequest } from 'next/server'

import { idSchema, type ApiErrorBody, type SessionUser } from '@/lib/contracts'
import { AiProviderError, aiErrorMessage } from '@/server/ai/provider'
import { resolveWorkspaceAccess, type WorkspaceAccess } from '@/server/auth/access'
import { getUserFromRequest } from '@/server/auth/current-user'
import { getConfiguredAppUrl } from '@/server/env'
import { parseWith } from '@/server/http/body'
import { Errors, isAppError, pgErrorCode } from '@/server/http/errors'
import { log } from '@/server/logger'
import { getServices } from '@/server/services'

/** Postgres "undefined table / schema / column": the database is missing migrations. */
export function isSchemaMissing(error: unknown) {
  const code = pgErrorCode(error)
  return code === '42P01' || code === '3F000' || code === '42703'
}

/** Header carrying the active workspace on every workspace-scoped request. */
export const WORKSPACE_HEADER = 'x-workspace-id'

/** The workspace a request names in X-Workspace-Id, or null when absent or malformed. */
export function requestedWorkspaceId(req: Request): string | null {
  const parsed = idSchema.safeParse(req.headers.get(WORKSPACE_HEADER))
  return parsed.success ? parsed.data : null
}

type Params = Record<string, string>

export interface RouteContext<P extends Params> {
  params: Promise<P>
}

interface BaseArgs<P extends Params> {
  req: NextRequest
  params: P
  requestId: string
}

export interface AuthedArgs<P extends Params> extends BaseArgs<P> {
  user: SessionUser
}

export interface PublicArgs<P extends Params> extends BaseArgs<P> {
  user: SessionUser | null
}

export interface WorkspaceArgs<P extends Params> extends AuthedArgs<P> {
  access: WorkspaceAccess
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Every protected endpoint goes through here, so authentication does not depend on
 * middleware alone (the old code had a single, broken check in middleware).
 */
export function authedRoute<P extends Params = Params>(handler: (args: AuthedArgs<P>) => Promise<Response>) {
  return (req: NextRequest, context: RouteContext<P>) =>
    execute(req, context, (base, user) => {
      if (!user) throw Errors.unauthenticated()
      return handler({ ...base, user })
    })
}

export function publicRoute<P extends Params = Params>(handler: (args: PublicArgs<P>) => Promise<Response>) {
  return (req: NextRequest, context: RouteContext<P>) => execute(req, context, (base, user) => handler({ ...base, user }))
}

/**
 * Authenticated + scoped to the workspace named in the X-Workspace-Id header. Non-members get 404.
 * Handlers then check the permission they need (see server/auth/permissions.ts).
 */
export function workspaceRoute<P extends Params = Params>(handler: (args: WorkspaceArgs<P>) => Promise<Response>) {
  return authedRoute<P>(async (args) => {
    const workspaceId = requestedWorkspaceId(args.req)
    if (!workspaceId) throw Errors.badRequest('Select a workspace first (missing or invalid X-Workspace-Id header).')
    const access = await resolveWorkspaceAccess(getServices().repos, args.user.id, workspaceId)
    return handler({ ...args, access })
  })
}

/**
 * Authenticated + scoped to the workspace in the path (`/api/workspaces/:id/…`): the id is
 * validated and membership resolved (non-members get 404). For workspace administration routes.
 */
export function workspaceParamRoute<P extends Params & { id: string } = { id: string }>(handler: (args: WorkspaceArgs<P>) => Promise<Response>) {
  return authedRoute<P>(async (args) => {
    const access = await resolveWorkspaceAccess(getServices().repos, args.user.id, parseWith(idSchema, args.params.id))
    return handler({ ...args, access })
  })
}

async function execute<P extends Params>(
  req: NextRequest,
  context: RouteContext<P> | undefined,
  run: (base: BaseArgs<P>, user: SessionUser | null) => Promise<Response>,
): Promise<Response> {
  const requestId = crypto.randomUUID()
  try {
    if (!SAFE_METHODS.has(req.method)) assertSameOrigin(req)
    const params = ((await context?.params) ?? {}) as P
    const user = await getUserFromRequest(req)
    return await run({ req, params, requestId }, user)
  } catch (error) {
    return errorResponse(error, requestId, req)
  }
}

/**
 * CSRF defence in depth on top of SameSite=Lax cookies: browsers always send Origin on
 * cross-site POST/PATCH/DELETE, so a mismatch means the request came from another site.
 */
function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get('origin')
  if (origin === null) return
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    throw Errors.forbidden('Cross-origin request blocked.')
  }
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  if (host && originHost === host) return
  const appUrl = getConfiguredAppUrl()
  if (appUrl) {
    try {
      if (new URL(appUrl).host === originHost) return
    } catch {
      // fall through
    }
  }
  throw Errors.forbidden('Cross-origin request blocked.')
}

export function json<T>(data: T, init?: ResponseInit): NextResponse<T> {
  const res = NextResponse.json(data, init)
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export function errorResponse(error: unknown, requestId: string, req?: NextRequest): NextResponse<ApiErrorBody> {
  const where = req ? { method: req.method, path: req.nextUrl.pathname } : {}
  if (isAppError(error)) {
    if (error.status >= 500) log.warn('Request failed', { requestId, code: error.code, status: error.status, ...where })
    const res = json<ApiErrorBody>({ error: { code: error.code, message: error.message, details: error.details, requestId } }, { status: error.status })
    for (const [key, value] of Object.entries(error.headers ?? {})) res.headers.set(key, value)
    return res
  }
  if (error instanceof AiProviderError) {
    // Vendor trouble (quota, outage) during a synchronous AI call, e.g. re-embedding an edited passage.
    log.warn('AI provider error', { requestId, status: error.status, dailyQuota: error.dailyQuota, message: error.message, ...where })
    const limited = error.status === 429
    return json<ApiErrorBody>({ error: { code: limited ? 'AI_RATE_LIMITED' : 'AI_UNAVAILABLE', message: aiErrorMessage(error), requestId } }, { status: limited ? 429 : 503 })
  }
  if (isSchemaMissing(error)) {
    log.error('Database schema missing — run `npm run db:migrate`', error, { requestId, ...where })
    return json<ApiErrorBody>(
      { error: { code: 'SCHEMA_MISSING', message: 'The database schema is missing or out of date. Run `npm run db:migrate` on the server.', requestId } },
      { status: 503 },
    )
  }
  log.error('Unhandled route error', error, { requestId, ...where })
  return json<ApiErrorBody>({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId } }, { status: 500 })
}
