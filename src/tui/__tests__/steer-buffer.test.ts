import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SteerBuffer } from '../steer-buffer.js'

describe('SteerBuffer', () => {
  it('push + hasPending + drain basic flow', () => {
    const buf = new SteerBuffer()
    assert.equal(buf.hasPending(), false)

    buf.push('focus on performance')
    assert.equal(buf.hasPending(), true)

    const drained = buf.drain()
    assert.equal(drained, '[User guidance]: focus on performance')
    assert.equal(buf.hasPending(), false)
  })

  it('drains multiple messages with numbered format', () => {
    const buf = new SteerBuffer()
    buf.push('first guidance')
    buf.push('second guidance')
    buf.push('third guidance')

    const drained = buf.drain()
    assert.equal(
      drained,
      '[User guidance]:\n1. first guidance\n2. second guidance\n3. third guidance',
    )
    assert.equal(buf.hasPending(), false)
  })

  it('drain on empty buffer returns null', () => {
    const buf = new SteerBuffer()
    assert.equal(buf.drain(), null)
  })

  it('clear removes all pending messages', () => {
    const buf = new SteerBuffer()
    buf.push('a')
    buf.push('b')
    assert.equal(buf.hasPending(), true)

    buf.clear()
    assert.equal(buf.hasPending(), false)
    assert.equal(buf.drain(), null)
  })

  it('subscribe notifies on push, drain, and clear', () => {
    const buf = new SteerBuffer()
    const calls: boolean[] = []
    const unsub = buf.subscribe(() => {
      calls.push(buf.hasPending())
    })

    buf.push('hello')
    buf.push('world')
    assert.equal(buf.drain(), '[User guidance]:\n1. hello\n2. world')
    buf.push('again')
    buf.clear()

    assert.deepEqual(calls, [true, true, false, true, false])

    unsub()
    buf.push('after unsubscribe')
    assert.equal(calls.length, 5)
  })

  it('popLast retrieves most recent message and notifies (W4a Up-arrow)', () => {
    const buf = new SteerBuffer()
    assert.equal(buf.popLast(), null)

    buf.push('first')
    buf.push('second')

    let notified = false
    buf.subscribe(() => { notified = true })

    assert.equal(buf.popLast(), 'second')
    assert.equal(notified, true)
    assert.deepEqual([...buf.getPending()], ['first'])

    assert.equal(buf.popLast(), 'first')
    assert.equal(buf.hasPending(), false)
  })

  it('drain resets buffer so subsequent push starts fresh', () => {
    const buf = new SteerBuffer()
    buf.push('first batch')
    const first = buf.drain()
    assert.equal(first, '[User guidance]: first batch')

    buf.push('second batch')
    const second = buf.drain()
    assert.equal(second, '[User guidance]: second batch')
  })
})
