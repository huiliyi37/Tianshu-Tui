import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SteerBuffer } from '../steer-buffer.js'

// Contract after the interrupt-preserve fix (2026-06-05):
// onError (like onAbort) must PRESERVE queued guidance by peeking via
// getPending(), NOT by draining. Draining here would empty the buffer with no
// working re-injection, silently discarding the user's queued guidance. The
// buffer must survive an error and be injected at the next tool-using turn.
describe('SteerBuffer: onError preserves messages (peek, not drain)', () => {
  it('getPending() exposes queued messages without consuming them', () => {
    const buf = new SteerBuffer()
    buf.push('user message 1')
    buf.push('user message 2')
    const pending = buf.getPending()
    assert.strictEqual(pending.length, 2)
    assert.ok(pending.includes('user message 1'))
    assert.ok(pending.includes('user message 2'))
    assert.strictEqual(buf.hasPending(), true, 'onError must NOT empty the buffer')
  })

  it('guidance queued before an error is still drainable afterwards', () => {
    const buf = new SteerBuffer()
    buf.push('survive the error')
    // onError only peeks…
    assert.strictEqual(buf.getPending().length, 1)
    // …so the real injection point (onSteerDrain) can still consume it.
    assert.ok(buf.drain()!.includes('survive the error'))
    assert.strictEqual(buf.hasPending(), false)
  })

  it('getPending returns empty array (not null) when buffer is empty', () => {
    const buf = new SteerBuffer()
    assert.strictEqual(buf.getPending().length, 0)
    assert.strictEqual(buf.hasPending(), false)
  })
})
