/**
 * Typed application errors. Route handlers throw these; `server/http/route.ts` turns them
 * into JSON responses. Anything that is not an AppError becomes a generic 500 so internal
 * details (SQL, stack traces, provider messages) never reach the client.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const Errors = {
  badRequest: (message = 'Invalid request.', details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details),
  validation: (details: unknown) => new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid.', details),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'),
  forbidden: (message = 'You do not have access to this resource.') => new AppError(403, 'FORBIDDEN', message),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`),
  conflict: (message: string) => new AppError(409, 'CONFLICT', message),
  payloadTooLarge: (message: string) => new AppError(413, 'PAYLOAD_TOO_LARGE', message),
  unsupportedMediaType: (message: string) => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message),
  unprocessable: (message: string) => new AppError(422, 'UNPROCESSABLE', message),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(
      429,
      'RATE_LIMITED',
      'Too many requests. Please wait a moment and try again.',
      { retryAfterSeconds },
      {
        'Retry-After': String(retryAfterSeconds),
      },
    ),
  upstream: (message: string) => new AppError(502, 'UPSTREAM_ERROR', message),
  notConfigured: (message: string) => new AppError(503, 'NOT_CONFIGURED', message),
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

/** Postgres error code of a driver error (Neon, pg and PGlite all expose `code`). */
export function pgErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
