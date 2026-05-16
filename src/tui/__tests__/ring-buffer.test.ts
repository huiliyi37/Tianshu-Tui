import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRingBuffer } from '../ring-buffer.js'

describe('createRingBuffer', () => {
  it('appends items up to cap', () => {
    const buf = createRingBuffer<string>(3)
    buf.push('a')
    buf.push('b')
    assert.deepEqual(buf.items(), ['a', 'b'])
  })

  it('evicts oldest when cap exceeded', () => {
    const buf = createRingBuffer<string>(3)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.push('d')
    assert.deepEqual(buf.items(), ['b', 'c', 'd'])
  })

  it('handles cap of 1', () => {
    const buf = createRingBuffer<string>(1)
    buf.push('a')
    buf.push('b')
    assert.deepEqual(buf.items(), ['b'])
  })

  it('returns empty array when no items', () => {
    const buf = createRingBuffer<string>(5)
    assert.deepEqual(buf.items(), [])
  })

  it('reports size correctly', () => {
    const buf = createRingBuffer<number>(3)
    assert.equal(buf.size, 0)
    buf.push(1)
    assert.equal(buf.size, 1)
    buf.push(2)
    buf.push(3)
    buf.push(4)
    assert.equal(buf.size, 3)
  })
})
