type Level = 'debug' | 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack, code: (error as { code?: unknown }).code }
  }
  return { message: String(error) }
}

function emit(level: Level, message: string, fields?: Fields) {
  if (level === 'debug' && process.env.NODE_ENV === 'production') return
  const entry = JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...fields })
  if (level === 'error') console.error(entry)
  else if (level === 'warn') console.warn(entry)
  else console.log(entry)
}

type ErrorReporter = (error: unknown, message: string, fields: Fields) => void
let reporter: ErrorReporter | null = null

/**
 * Where logged errors are also sent (Sentry, set by instrumentation.ts when SENTRY_DSN is set). A hook
 * rather than an import keeps the error tracker out of the edge middleware bundle.
 */
export function setErrorReporter(next: ErrorReporter | null) {
  reporter = next
}

/** Structured JSON logger. Never pass secrets, tokens or OTP codes (except the explicit dev-only OTP hint). */
export const log = {
  debug: (message: string, fields?: Fields) => emit('debug', message, fields),
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, error?: unknown, fields?: Fields) => {
    emit('error', message, { ...fields, ...(error === undefined ? {} : { error: serializeError(error) }) })
    if (reporter && error !== undefined) {
      try {
        reporter(error, message, fields ?? {})
      } catch {
        // reporting must never break the code path that logged
      }
    }
  },
}
