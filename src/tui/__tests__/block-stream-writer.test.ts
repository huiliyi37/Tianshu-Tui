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

  it('emits at a sentence-ending punctuation before reaching maxChars', () => {
    const localEmitted: string[] = []
    const sentenceWriter = new BlockStreamWriter({}, (text) => { localEmitted.push(text) })
    const first = '这是一段连续不断的中文叙述用来验证句末标点切块行为正确无误啊'
    sentenceWriter.push(first + '。' + '后面还有更多内容继续追加进来填充缓冲区')
    assert.ok(localEmitted.length >= 1, 'should emit on sentence punctuation')
    assert.ok(localEmitted[0]!.endsWith('。'), `block should end at 。 but got: ${localEmitted[0]}`)
    assert.ok(!localEmitted[0]!.includes('后面还有'), 'should not include post-punctuation tail')
  })

  it('default maxChars is lowered to 200', () => {
    const localEmitted: string[] = []
    const big = new BlockStreamWriter({}, (text) => { localEmitted.push(text) })
    big.push('字'.repeat(650))
    assert.ok(localEmitted.length >= 2, 'long unbroken text must be chunked, not held to 600')
    assert.ok(localEmitted.every(b => b.length <= 200), `each block <= 200, got: ${localEmitted.map(b => b.length)}`)
  })

  it('flushes a short buffer after the idle window (<=200ms)', async () => {
    const localEmitted: string[] = []
    const w = new BlockStreamWriter({}, (text) => { localEmitted.push(text) })
    w.push('短句无标点也无换行')
    assert.equal(localEmitted.length, 0, 'nothing emitted synchronously below minChars')
    await new Promise(r => setTimeout(r, 220))
    assert.equal(localEmitted.length, 1, 'idle flush must fire within ~200ms')
    assert.equal(localEmitted[0], '短句无标点也无换行')
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

  // Regression: enforceBufferLimit's `while (buffer.length > maxBufferSize)`
  // loop relies on findBreakPoint returning a positive cut. A degenerate config
  // (maxChars <= 0) made it return 0 → buffer.slice(0) unchanged → infinite
  // 100% CPU spin (same non-advancing-loop class that froze the TUI via
  // parseBlocks). The writer must always terminate and drain the buffer.
  it('terminates when maxChars is misconfigured to 0 (no 100% CPU spin)', async () => {
    const out: string[] = []
    // If the guard regresses, this push never returns and the test runner
    // times out — a hang is the failure signal.
    const w = new BlockStreamWriter(
      { minChars: 1, maxChars: 0, idleMs: 100, maxBufferSize: 10 },
      (text) => { out.push(text) },
    )
    w.push('y'.repeat(50))
    await w.flush()
    assert.ok(out.length >= 1, 'must still emit blocks')
    assert.equal(out.join(''), 'y'.repeat(50), 'all input must be drained, none lost or duplicated')
  })

  it('terminates on a long unbroken token with no break points (cap forces progress)', async () => {
    const out: string[] = []
    const w = new BlockStreamWriter(
      { minChars: 1, maxChars: 5, idleMs: 100, maxBufferSize: 8 },
      (text) => { out.push(text) },
    )
    // No spaces/newlines/punctuation → findBreakPoint falls back to maxPos.
    w.push('Z'.repeat(40))
    await w.flush()
    assert.equal(out.join(''), 'Z'.repeat(40), 'all chars drained exactly once')
  })

  it('peek() returns the current unemitted tail', () => {
    const w = new BlockStreamWriter({ minChars: 100, maxChars: 200, idleMs: 100, maxBufferSize: 64 * 1024 }, () => {})
    w.push('short tail') // below minChars → not emitted
    assert.equal(w.peek(), 'short tail')
  })

  it('peek() shrinks as blocks are emitted', () => {
    const out: string[] = []
    const w = new BlockStreamWriter({ minChars: 10, maxChars: 20, idleMs: 100, maxBufferSize: 64 * 1024 }, (t) => out.push(t))
    w.push('a'.repeat(25) + ' tail') // forces an emit at maxChars
    assert.ok(out.length >= 1, 'should have emitted at least one block')
    assert.ok(w.peek().length < 30, 'tail should be smaller than total pushed')
  })
})
