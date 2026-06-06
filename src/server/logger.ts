export interface ServerLogger {
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

let activeLogger: ServerLogger = {
  warn: (message, context) => {
    console.warn(formatLog('WARN', message, context))
  },
  error: (message, context) => {
    console.error(formatLog('ERROR', message, context))
  },
}

export const serverLogger: ServerLogger = {
  warn(message, context) {
    activeLogger.warn(message, context)
  },
  error(message, context) {
    activeLogger.error(message, context)
  },
}

export function setServerLogger(logger: ServerLogger): void {
  activeLogger = logger
}

export function resetServerLogger(): void {
  activeLogger = {
    warn: (message, context) => {
      console.warn(formatLog('WARN', message, context))
    },
    error: (message, context) => {
      console.error(formatLog('ERROR', message, context))
    },
  }
}

export function errorContext(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { message: String(error) }
}

function formatLog(level: string, message: string, context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) return `[server:${level}] ${message}`
  return `[server:${level}] ${message} ${safeJson(context)}`
}

function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '{"error":"unserializable context"}'
  }
}
