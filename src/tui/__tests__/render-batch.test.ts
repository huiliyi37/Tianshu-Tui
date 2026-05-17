import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RenderBatcher } from '../render-batch.js'

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve()
}

describe('RenderBatcher', () => {
  it('batches same-tick pushes into one flush', async () => {
    const flushed: string[][] = []
    const batcher = new RenderBatcher<string>((items) => flushed.push(items))

    batcher.push('a')
    batcher.push('b')
    batcher.push('c')

    assert.equal(batcher.pending, 3)
    await drainMicrotasks()

    assert.deepEqual(flushed, [['a', 'b', 'c']])
    assert.equal(batcher.pending, 0)
  })

  it('flushes synchronously without duplicating the queued microtask', async () => {
    const flushed: string[][] = []
    const batcher = new RenderBatcher<string>((items) => flushed.push(items))

    batcher.push('a')
    batcher.push('b')
    batcher.flushNow()

    assert.deepEqual(flushed, [['a', 'b']])
    assert.equal(batcher.pending, 0)

    await drainMicrotasks()

    assert.deepEqual(flushed, [['a', 'b']])
  })

  it('accepts new items after a synchronous flush', async () => {
    const flushed: string[][] = []
    const batcher = new RenderBatcher<string>((items) => flushed.push(items))

    batcher.push('a')
    batcher.flushNow()
    batcher.push('b')

    await drainMicrotasks()

    assert.deepEqual(flushed, [['a'], ['b']])
  })
})
