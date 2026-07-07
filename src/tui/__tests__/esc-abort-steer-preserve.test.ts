import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SteerBuffer } from '../steer-buffer.js'

// Contract after the interrupt-preserve fix (2026-06-05):
// ESC×2 / Ctrl+C / onAbort / onError / onTurnComplete must PRESERVE queued
// guidance by PEEKING via getPending() — NOT by drain(). drain() empties the
// buffer, and the interrupt path has no working re-injection (addAnchor only
// updates the display ledger). The single real consumption point is
// onSteerDrain → tool_result. So the buffer must survive an interrupt intact
// and be consumed (once) only at the next tool-using turn.
describe('SteerBuffer: interrupt preserves messages (peek, not drain)', () => {
  it('getPending() returns queued messages WITHOUT emptying the buffer', () => {
    const buf = new SteerBuffer()
    buf.push('message before abort')
    buf.push('second queued message')
    const pending = buf.getPending()
    assert.strictEqual(pending.length, 2, 'both messages visible')
    assert.ok(pending.includes('message before abort'), 'first message preserved')
    assert.ok(pending.includes('second queued message'), 'second message preserved')
    // The defining property the interrupt handler relies on: peeking does NOT
    // consume, so the guidance survives to the next turn.
    assert.strictEqual(buf.hasPending(), true, 'buffer still has pending after peek')
  })

  it('survives repeated interrupts: peek count is stable across aborts', () => {
    const buf = new SteerBuffer()
    buf.push('keep me')
    // Simulate ESC then later Ctrl+C — both only peek.
    assert.strictEqual(buf.getPending().length, 1)
    assert.strictEqual(buf.getPending().length, 1, 'second interrupt still sees it')
    assert.strictEqual(buf.hasPending(), true)
  })

  it('drain() is the single consumption point — empties and returns once', () => {
    const buf = new SteerBuffer()
    buf.push('inject at tool result')
    const drained = buf.drain()
    assert.ok(drained!.includes('inject at tool result'), 'returned for injection')
    assert.strictEqual(buf.hasPending(), false, 'consumed exactly once')
    assert.strictEqual(buf.drain(), null, 'second drain is a no-op')
  })

  it('messages pushed after a consumed turn are preserved for the next drain', () => {
    const buf = new SteerBuffer()
    buf.push('first')
    buf.drain()
    buf.push('after abort')
    assert.strictEqual(buf.getPending().length, 1, 'new guidance queued')
    assert.ok(buf.drain()!.includes('after abort'))
  })
})
