import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyApiError, fetchCauseDetail, parseRetryAfterMs } from '../error-classifier.js'
import type { ErrorCategory } from '../error-classifier.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mimics the ApiError class from client.ts */
class FakeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyApiError', () => {
  // ---- Status code path -------------------------------------------------

  it('classifies 429 as rate_limit with 5 retries', () => {
    const result = classifyApiError(new FakeApiError('Rate limited', 429))
    assert.equal(result.category, 'rate_limit')
    assert.equal(result.retryable, true)
    assert.equal(result.shouldReconnect, true)
    assert.equal(result.maxRetries, 5)
  })

  it('classifies 529 as overloaded', () => {
    const result = classifyApiError(new FakeApiError('Overloaded', 529))
    assert.equal(result.category, 'overloaded')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies 503 as overloaded', () => {
    const result = classifyApiError(new FakeApiError('Service unavailable', 503))
    assert.equal(result.category, 'overloaded')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies 500 as server_error', () => {
    const result = classifyApiError(new FakeApiError('Internal server error', 500))
    assert.equal(result.category, 'server_error')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies 502 as server_error', () => {
    const result = classifyApiError(new FakeApiError('Bad gateway', 502))
    assert.equal(result.category, 'server_error')
    assert.equal(result.retryable, true)
  })

  it('classifies 401 as auth_error', () => {
    const result = classifyApiError(new FakeApiError('Unauthorized', 401))
    assert.equal(result.category, 'auth_error')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
  })

  it('classifies 403 as auth_error', () => {
    const result = classifyApiError(new FakeApiError('Forbidden', 403))
    assert.equal(result.category, 'auth_error')
    assert.equal(result.retryable, false)
  })

  it('classifies 408 as timeout (retryable)', () => {
    const result = classifyApiError(new FakeApiError('Request Timeout', 408))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies 425 as overloaded (retryable)', () => {
    const result = classifyApiError(new FakeApiError('Too Early', 425))
    assert.equal(result.category, 'overloaded')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies 413 as context_overflow', () => {
    const result = classifyApiError(new FakeApiError('Payload too large', 413))
    assert.equal(result.category, 'context_overflow')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
  })

  it('classifies generic 4xx as client_error', () => {
    const result = classifyApiError(new FakeApiError('Conflict', 409))
    assert.equal(result.category, 'client_error')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
  })

  it('classifies generic 5xx as server_error', () => {
    const result = classifyApiError(new FakeApiError('Not implemented', 501))
    assert.equal(result.category, 'server_error')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  // ---- Codex-style embedded status in message ---------------------------

  it('extracts status from Codex-style "(429)" in message', () => {
    const result = classifyApiError(new Error('Codex API error (429): rate limited'))
    assert.equal(result.category, 'rate_limit')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 5)
  })

  it('extracts status from Codex-style "(500)" in message', () => {
    const result = classifyApiError(new Error('Codex API error (500): internal'))
    assert.equal(result.category, 'server_error')
    assert.equal(result.retryable, true)
  })

  // ---- retryAfterMs override --------------------------------------------

  it('uses retryAfterMs from ApiError when available', () => {
    const result = classifyApiError(new FakeApiError('Rate limited', 429, 5000))
    assert.equal(result.category, 'rate_limit')
    assert.equal(result.retryDelayMs, 5000)
  })

  // ---- Error name / message pattern path --------------------------------

  it('classifies ECONNRESET by name as timeout', () => {
    const err = new Error('connection reset')
    err.name = 'ECONNRESET'
    const result = classifyApiError(err)
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies ECONNRESET in message as timeout', () => {
    const result = classifyApiError(new Error('read ECONNRESET'))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
  })

  it('classifies EPIPE in message as timeout', () => {
    const result = classifyApiError(new Error('write EPIPE'))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
  })

  it('classifies ECONNREFUSED in message as timeout', () => {
    const result = classifyApiError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
  })

  it('classifies timeout message as timeout', () => {
    const result = classifyApiError(new Error('request timed out'))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies TimeoutError by name as timeout', () => {
    const err = new Error('timeout exceeded')
    err.name = 'TimeoutError'
    const result = classifyApiError(err)
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
  })

  // 4e1aaa21 post-mortem: raw undici TimeoutError DOMException (fired by an
  // AbortSignal.timeout mid-body) must classify as retryable timeout, NOT as
  // a user AbortError (DOMException name takes precedence over instance type).
  it('classifies undici AbortSignal.timeout DOMException as retryable timeout', () => {
    const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const result = classifyApiError(err)
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
  })

  it('classifies AbortError as client_error (no retry)', () => {
    const err = new DOMException('Aborted', 'AbortError')
    const result = classifyApiError(err)
    assert.equal(result.category, 'client_error')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
  })

  it('classifies "prompt is too long" as context_overflow', () => {
    const result = classifyApiError(new Error('prompt is too long: 200000 tokens'))
    assert.equal(result.category, 'context_overflow')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
  })

  it('classifies "context_length_exceeded" as context_overflow', () => {
    const result = classifyApiError(new Error('context_length_exceeded: max 128k'))
    assert.equal(result.category, 'context_overflow')
    assert.equal(result.retryable, false)
  })

  it('classifies stream parse errors as stream_parse', () => {
    const result = classifyApiError(new Error('failed to stream parse SSE event'))
    assert.equal(result.category, 'stream_parse')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 2)
  })

  it('classifies "invalid SSE" as stream_parse', () => {
    const result = classifyApiError(new Error('invalid SSE data received'))
    assert.equal(result.category, 'stream_parse')
    assert.equal(result.retryable, true)
  })

  // ---- undici "fetch failed" cause-chain unwrapping ----------------------
  // Node's fetch throws TypeError('fetch failed') with the real network error
  // in err.cause. It must classify as a reconnectable network failure (NOT the
  // unknown fallback whose shouldReconnect=false disables agent-level reconnect)
  // and the user message must surface the buried cause.

  it('classifies bare "fetch failed" (no cause) as reconnectable network error', () => {
    const result = classifyApiError(new TypeError('fetch failed'))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
    assert.equal(result.shouldReconnect, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies fetch failed with ECONNREFUSED cause and surfaces the detail', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 104.18.27.90:443'), { code: 'ECONNREFUSED' })
    const result = classifyApiError(new TypeError('fetch failed', { cause }))
    assert.equal(result.category, 'timeout')
    assert.equal(result.shouldReconnect, true)
    assert.match(result.userMessage, /ECONNREFUSED 104\.18\.27\.90:443/)
  })

  it('classifies fetch failed with ENOTFOUND cause (DNS) as reconnectable', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.deepseek.com'), { code: 'ENOTFOUND' })
    const result = classifyApiError(new TypeError('fetch failed', { cause }))
    assert.equal(result.retryable, true)
    assert.equal(result.shouldReconnect, true)
    assert.match(result.userMessage, /ENOTFOUND api\.deepseek\.com/)
  })

  it('unwraps nested cause chains (fetch failed → SocketError → ECONNRESET)', () => {
    const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const mid = new Error('other side closed', { cause: inner })
    const result = classifyApiError(new TypeError('fetch failed', { cause: mid }))
    assert.equal(result.shouldReconnect, true)
    assert.match(result.userMessage, /other side closed/)
    assert.match(result.userMessage, /ECONNRESET/)
  })

  it('unwraps AggregateError causes (Happy Eyeballs multi-address connect)', () => {
    const agg = new AggregateError(
      [
        Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('connect ENETUNREACH ::1:443'), { code: 'ENETUNREACH' }),
      ],
      'connect failed',
    )
    const result = classifyApiError(new TypeError('fetch failed', { cause: agg }))
    assert.equal(result.retryable, true)
    assert.equal(result.shouldReconnect, true)
    assert.match(result.userMessage, /ETIMEDOUT 1\.2\.3\.4:443/)
  })

  it('fetchCauseDetail returns null when there is no cause', () => {
    assert.equal(fetchCauseDetail(new Error('plain')), null)
    assert.equal(fetchCauseDetail('not an error'), null)
    assert.equal(fetchCauseDetail(null), null)
  })

  // ---- Fallback / edge cases --------------------------------------------

  it('classifies unknown error as unknown with retry', () => {
    const result = classifyApiError(new Error('something went wrong'))
    assert.equal(result.category, 'unknown')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 2)
  })

  it('handles non-Error input (string)', () => {
    const result = classifyApiError('plain string error')
    assert.equal(result.category, 'unknown')
    assert.equal(result.retryable, true)
  })

  it('handles null input', () => {
    const result = classifyApiError(null)
    assert.equal(result.category, 'unknown')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 2)
  })

  it('handles undefined input', () => {
    const result = classifyApiError(undefined)
    assert.equal(result.category, 'unknown')
    assert.equal(result.retryable, true)
  })

  it('handles plain object with status property', () => {
    const result = classifyApiError({ status: 429, message: 'rate limited' })
    assert.equal(result.category, 'rate_limit')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 5)
  })

  it('every ErrorCategory has at least one positive test', () => {
    // Verify all categories are reachable
    const categories: ErrorCategory[] = [
      'rate_limit', 'overloaded', 'server_error', 'timeout',
      'auth_error', 'client_error', 'context_overflow',
      'stream_parse', 'unknown',
    ]
    const covered = new Set<ErrorCategory>()

    const cases: unknown[] = [
      new FakeApiError('', 429),          // rate_limit
      new FakeApiError('', 529),          // overloaded
      new FakeApiError('', 500),          // server_error
      Object.assign(new Error(''), { name: 'ECONNRESET' }), // timeout
      new FakeApiError('', 401),          // auth_error
      new FakeApiError('', 409),          // client_error
      new FakeApiError('', 413),          // context_overflow
      new Error('stream parse error'),    // stream_parse
      new Error('mystery'),              // unknown
    ]

    for (const c of cases) {
      covered.add(classifyApiError(c).category)
    }

    for (const cat of categories) {
      assert.ok(covered.has(cat), `Category "${cat}" not covered`)
    }
    assert.equal(covered.size, categories.length, 'All categories covered')
  })
})

describe('parseRetryAfterMs', () => {
  it('parses numeric seconds to milliseconds', () => {
    const result = parseRetryAfterMs('30')
    assert.equal(result, 30_000)
  })

  it('parses decimal seconds to milliseconds', () => {
    const result = parseRetryAfterMs('2.5')
    assert.equal(result, 2_500)
  })

  it('parses HTTP-date format by computing delta from now', () => {
    const futureDate = new Date(Date.now() + 30_000).toUTCString()
    const result = parseRetryAfterMs(futureDate)
    assert.ok(typeof result === 'number', 'should return a number for HTTP-date')
    assert.ok(result! > 20_000 && result! < 40_000, `delta should be ~30s, got ${result}`)
  })

  it('returns undefined for past HTTP-date', () => {
    const pastDate = new Date(Date.now() - 30_000).toUTCString()
    const result = parseRetryAfterMs(pastDate)
    assert.equal(result, undefined)
  })

  it('returns undefined for non-numeric non-date string', () => {
    const result = parseRetryAfterMs('not-a-number')
    assert.equal(result, undefined)
  })

  it('returns undefined for empty string', () => {
    const result = parseRetryAfterMs('')
    assert.equal(result, undefined)
  })

  it('handles zero as zero milliseconds', () => {
    const result = parseRetryAfterMs('0')
    assert.equal(result, 0)
  })
})
