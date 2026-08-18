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
//
// 补充（2026-08-08，ESC 回填）：用户主动 ESC 的 run settle 之后还有一个
// 第二消费点——notifyRunSettled → 自然结束 shift() 自动作为下一轮发出；
// 用户主动 ESC 则 backfillSteerToInput（输入框为空时把排队原文拉回输入框）。
// 两者都刻意不用 drain()：drain 会把文本包进 [User guidance] 注入格式，
// 新 prompt / 回填要的是原文。这不违反上面的 peek-only 契约——契约锁的是
// interrupt 路径本身（abort 时 run 还活着，drain 会丢消息）；消费发生在
// run 已 settle、队列再没有工具边界可 drain 之后。
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
