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

/** Structured JSON logger. Never pass secrets, tokens or OTP codes (except the explicit dev-only OTP hint). */
export const log = {
  debug: (message: string, fields?: Fields) => emit('debug', message, fields),
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, error?: unknown, fields?: Fields) => emit('error', message, { ...fields, ...(error === undefined ? {} : { error: serializeError(error) }) }),
}
