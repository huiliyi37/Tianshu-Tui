import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SteerBuffer } from '../steer-buffer.js'

describe('SteerBuffer: abort preserves messages', () => {
  it('drain returns messages that would be lost on clear', () => {
    const buf = new SteerBuffer()
    buf.push('message before abort')
    buf.push('second queued message')
    const drained = buf.drain()
    assert.ok(drained !== null, 'drain should return messages')
    assert.ok(drained!.includes('message before abort'), 'first message preserved')
    assert.ok(drained!.includes('second queued message'), 'second message preserved')
    assert.strictEqual(buf.hasPending(), false, 'buffer empty after drain')
  })

  it('drain returns null when no messages', () => {
    const buf = new SteerBuffer()
    const result = buf.drain()
    assert.strictEqual(result, null)
  })

  it('messages pushed after abort are preserved on next drain', () => {
    const buf = new SteerBuffer()
    buf.push('first')
    const first = buf.drain()
    assert.ok(first!.includes('first'))
    buf.push('after abort')
    const second = buf.drain()
    assert.ok(second!.includes('after abort'))
  })
})
