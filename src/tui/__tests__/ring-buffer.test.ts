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

describe('RingBuffer clear and drain', () => {
  it('clear removes all items', () => {
    const buf = createRingBuffer<string>(10)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.clear()
    assert.deepEqual(buf.items(), [])
    assert.equal(buf.size, 0)
  })

  it('drain removes first n items and returns them', () => {
    const buf = createRingBuffer<string>(10)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.push('d')
    const drained = buf.drain(2)
    assert.deepEqual(drained, ['a', 'b'])
    assert.deepEqual(buf.items(), ['c', 'd'])
  })

  it('drain with count > size drains all', () => {
    const buf = createRingBuffer<string>(10)
    buf.push('a')
    buf.push('b')
    const drained = buf.drain(5)
    assert.deepEqual(drained, ['a', 'b'])
    assert.deepEqual(buf.items(), [])
  })

  it('drain 0 returns empty and leaves buffer unchanged', () => {
    const buf = createRingBuffer<string>(10)
    buf.push('a')
    buf.push('b')
    const drained = buf.drain(0)
    assert.deepEqual(drained, [])
    assert.deepEqual(buf.items(), ['a', 'b'])
  })
})
