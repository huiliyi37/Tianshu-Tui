import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { wrapBodyTimeoutError } from '../abort-reader.js'
import { classifyApiError } from '../error-classifier.js'

describe('wrapBodyTimeoutError', () => {
  it('wraps a body-phase TimeoutError DOMException into a descriptive Error', () => {
    const raw = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const startedAt = Date.now() - 42_000
    const wrapped = wrapBodyTimeoutError(raw, 'OpenAI', startedAt)

    assert.ok(wrapped instanceof Error)
    assert.ok(!(wrapped instanceof DOMException), 'must not stay a DOMException')
    assert.match((wrapped as Error).message, /OpenAI SSE stream timed out mid-body/)
    assert.match((wrapped as Error).message, /42s/)
  })

  it('wrapped error classifies as retryable timeout', () => {
    const raw = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const wrapped = wrapBodyTimeoutError(raw, 'Anthropic', Date.now())
    const classified = classifyApiError(wrapped)
    assert.equal(classified.category, 'timeout')
    assert.equal(classified.retryable, true)
  })

  it('passes user AbortError through unchanged', () => {
    const abort = new DOMException('Aborted', 'AbortError')
    assert.equal(wrapBodyTimeoutError(abort, 'OpenAI', Date.now()), abort)
  })

  it('passes ordinary errors through unchanged', () => {
    const err = new Error('OpenAI SSE stream idle timeout (120s)')
    assert.equal(wrapBodyTimeoutError(err, 'OpenAI', Date.now()), err)
  })

  it('passes non-error values through unchanged', () => {
    assert.equal(wrapBodyTimeoutError(null, 'OpenAI', Date.now()), null)
    assert.equal(wrapBodyTimeoutError('boom', 'OpenAI', Date.now()), 'boom')
  })
})
