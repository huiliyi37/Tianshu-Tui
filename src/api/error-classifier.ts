/**
 * API Error Classifier — maps raw exceptions to structured recovery strategies.
 *
 * Used by the retry engine (task 2) to decide whether, how, and when to retry.
 * Pure functions, no side effects.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'timeout'
  | 'auth_error'
  | 'client_error'
  | 'context_overflow'
  | 'stream_parse'
  | 'unknown'

export interface ClassifiedError {
  retryable: boolean
  retryDelayMs: number
  shouldReconnect: boolean
  category: ErrorCategory
  userMessage: string
  maxRetries: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract HTTP status code from various error shapes. */
function extractStatus(error: unknown): number | null {
  if (error != null && typeof error === 'object') {
    // ApiError exposes .status directly
    const obj = error as Record<string, unknown>
    if (typeof obj.status === 'number') return obj.status

    // Codex-style message: "Codex API error (429): ..."
    if (obj.message && typeof obj.message === 'string') {
      const m = obj.message.match(/\((\d{3})\)/)
      if (m) return parseInt(m[1]!, 10)
    }
  }

  // Fallback: scan the error message if it's an Error
  if (error instanceof Error) {
    const m = error.message.match(/\((\d{3})\)/)
    if (m) return parseInt(m[1]!, 10)
  }

  return null
}

/** Classify based on HTTP status code. Returns null if status is unrecognised. */
function classifyByStatus(status: number): ClassifiedError | null {
  // Rate limit
  if (status === 429) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'rate_limit',
      userMessage: 'Rate limited — too many requests. Retrying after back-off.',
      maxRetries: 5,
    }
  }

  // Overloaded
  if (status === 529 || status === 503) {
    return {
      retryable: true,
      retryDelayMs: 3000,
      shouldReconnect: true,
      category: 'overloaded',
      userMessage: 'Server is overloaded. Retrying after back-off.',
      maxRetries: 3,
    }
  }

  // Generic server errors
  if (status === 500 || status === 502) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'server_error',
      userMessage: 'Server error. Retrying.',
      maxRetries: 3,
    }
  }

  // Request timeout (server timed out waiting for request) — transient, retryable
  if (status === 408) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'timeout',
      userMessage: 'Server request timeout. Retrying.',
      maxRetries: 3,
    }
  }

  // Too Early (RFC 8470) — server unwilling to process, retryable after delay
  if (status === 425) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'overloaded',
      userMessage: 'Server not ready (Too Early). Retrying.',
      maxRetries: 3,
    }
  }

  // Context overflow
  if (status === 413) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'context_overflow',
      userMessage: 'Request too large — context overflow.',
      maxRetries: 0,
    }
  }

  // Auth errors
  if (status === 401 || status === 403) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'auth_error',
      userMessage: 'Authentication failed. Check your API key.',
      maxRetries: 0,
    }
  }

  // Other 4xx
  if (status >= 400 && status < 500) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'client_error',
      userMessage: `Client error (${status}).`,
      maxRetries: 0,
    }
  }

  // Other 5xx
  if (status >= 500) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'server_error',
      userMessage: `Server error (${status}). Retrying.`,
      maxRetries: 3,
    }
  }

  return null
}

/** Classify based on error name / message patterns. */
function classifyByPattern(error: unknown): ClassifiedError {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()

  // Connection reset / refused
  if (
    name === 'ECONNRESET' ||
    name === 'EPIPE' ||
    name === 'ECONNREFUSED' ||
    /ECONNRESET|EPIPE|ECONNREFUSED/.test(message)
  ) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'timeout',
      userMessage: 'Connection lost. Reconnecting.',
      maxRetries: 3,
    }
  }

  // Timeout
  if (name === 'TimeoutError' || /timeout|timed?\s*out/i.test(message)) {
    return {
      retryable: true,
      retryDelayMs: 3000,
      shouldReconnect: true,
      category: 'timeout',
      userMessage: 'Request timed out. Retrying.',
      maxRetries: 3,
    }
  }

  // Upstream stream closed before first payload (cliproxy / proxy errors)
  if (/empty_stream|upstream.*stream.*closed|stream.*closed.*before.*payload/i.test(lower)) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'server_error',
      userMessage: 'Upstream stream closed. Retrying.',
      maxRetries: 3,
    }
  }

  // AbortError — user-initiated cancellation, never retry
  if (name === 'AbortError') {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'client_error',
      userMessage: 'Request was aborted.',
      maxRetries: 0,
    }
  }

  // Context overflow patterns
  if (
    /prompt is too long|context_length_exceeded|max.*token|context.*overflow/i.test(message)
  ) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'context_overflow',
      userMessage: 'Context too long — reduce prompt size.',
      maxRetries: 0,
    }
  }

  // Stream parse errors
  if (/stream.*parse|parse.*stream|invalid.*sse|unexpected.*event/i.test(lower)) {
    return {
      retryable: true,
      retryDelayMs: 1000,
      shouldReconnect: true,
      category: 'stream_parse',
      userMessage: 'Stream parse error. Reconnecting.',
      maxRetries: 2,
    }
  }

  // Fallback — unknown
  return {
    retryable: true,
    retryDelayMs: 2000,
    shouldReconnect: false,
    category: 'unknown',
    userMessage: `Unexpected error: ${message || 'unknown'}`,
    maxRetries: 2,
  }
}

/** Read retryAfterMs from the error object (set by ApiError (legacy)). */
function extractRetryAfter(error: unknown): number | undefined {
  if (error != null && typeof error === 'object') {
    const obj = error as Record<string, unknown>
    if (typeof obj.retryAfterMs === 'number') return obj.retryAfterMs
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify an API error into a structured recovery strategy.
 *
 * Priority: status code → error name → message pattern → fallback.
 */
export function classifyApiError(error: unknown): ClassifiedError {
  // 1. Try status-code based classification first
  const status = extractStatus(error)
  if (status !== null) {
    const result = classifyByStatus(status)
    if (result) {
      // Override delay with server-provided retryAfterMs if available
      const retryAfter = extractRetryAfter(error)
      if (retryAfter !== undefined) {
        return { ...result, retryDelayMs: retryAfter }
      }
      return result
    }
  }

  // 2. Fall back to name / message pattern classification
  return classifyByPattern(error)
}

/**
 * Parse Retry-After header value (RFC 7231 §7.1.3).
 * Numeric string → seconds × 1000.
 * HTTP-date string → delta from now in ms.
 * Unparseable → undefined.
 */
export function parseRetryAfterMs(value: string): number | undefined {
  const parsed = parseFloat(value)
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed * 1000
  }
  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}
