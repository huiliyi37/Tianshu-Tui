import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SteerBuffer } from '../steer-buffer.js'

describe('SteerBuffer: onError preserve messages', () => {
  it('drain preserves messages for next turn (onError should drain, not clear)', () => {
    const buf = new SteerBuffer()
    buf.push('user message 1')
    buf.push('user message 2')
    const drained = buf.drain()
    assert.ok(drained !== null, 'drain should return non-null')
    assert.ok(drained!.includes('user message 1'))
    assert.ok(drained!.includes('user message 2'))
    assert.strictEqual(buf.hasPending(), false)
  })

  it('drain returns null when empty without side effects', () => {
    const buf = new SteerBuffer()
    const result = buf.drain()
    assert.strictEqual(result, null)
  })
})
