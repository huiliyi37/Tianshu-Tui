import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { BlockStreamWriter, type BlockStreamConfig } from '../block-stream-writer.js'

describe('BlockStreamWriter', () => {
  let emitted: string[]
  let writer: BlockStreamWriter

  const config: BlockStreamConfig = { minChars: 10, maxChars: 20, idleMs: 5, maxBufferSize: 64 * 1024 }

  beforeEach(() => {
    emitted = []
    writer = new BlockStreamWriter(config, (text) => { emitted.push(text) })
  })

  it('emits when buffer exceeds maxChars at a break point', () => {
    writer.push('A'.repeat(25))
    assert.ok(emitted.length >= 1)
  })

  it('does not emit when buffer is below minChars', () => {
    writer.push('short')
    assert.equal(emitted.length, 0)
  })

  it('emits remaining on flush', async () => {
    writer.push('hello')
    assert.equal(emitted.length, 0)
    await writer.flush()
    assert.deepEqual(emitted, ['hello'])
  })

  it('emits on idle timeout', async () => {
    writer.push('above min chars')
    assert.equal(emitted.length, 0)
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.ok(emitted.length >= 1)
  })

  it('prefers paragraph break over newline', () => {
    const text = 'A'.repeat(8) + '\n\n' + 'B'.repeat(8)
    writer.push(text)
    assert.ok(emitted.length >= 1)
    assert.ok(emitted[0]!.includes('A'))
  })

  it('handles empty chunks', () => {
    writer.push('')
    assert.equal(emitted.length, 0)
  })

  it('serializes blocks in order', async () => {
    const order: string[] = []
    const slowWriter = new BlockStreamWriter(
      { minChars: 5, maxChars: 10, idleMs: 100 },
      (text) => { order.push(text) },
    )
    slowWriter.push('A'.repeat(15))
    slowWriter.push('B'.repeat(15))
    await slowWriter.flush()
    assert.ok(order.length >= 2)
    assert.equal(order[0]![0], 'A')
    assert.equal(order[order.length - 1]![0], 'B')
  })

  it('flush with empty buffer does not call onBlock', async () => {
    await writer.flush()
    assert.equal(emitted.length, 0)
  })

  it('enforces absolute buffer cap under burst input', async () => {
    const capped = new BlockStreamWriter(
      { minChars: 1_000, maxChars: 50, idleMs: 100, maxBufferSize: 120 },
      (text) => { emitted.push(text) },
    )

    capped.push('x'.repeat(500))
    await capped.flush()

    assert.ok(emitted.length > 1)
    assert.ok(emitted.every(chunk => chunk.length <= 120))
  })
})
