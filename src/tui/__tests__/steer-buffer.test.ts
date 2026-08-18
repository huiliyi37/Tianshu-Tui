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
    assert.equal(drained, '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]: focus on performance')
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
      '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]:\n1. first guidance\n2. second guidance\n3. third guidance',
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
    assert.equal(buf.drain(), '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]:\n1. hello\n2. world')
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
    assert.equal(first, '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]: first batch')

    buf.push('second batch')
    const second = buf.drain()
    assert.equal(second, '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]: second batch')
  })

  it('drains by priority: now > next > later', () => {
    const buf = new SteerBuffer()
    buf.push('later-1')
    buf.pushNext('next-1')
    buf.push('later-2')
    buf.pushNow('now-1')
    buf.pushNext('next-2')

    const drained = buf.drain()
    assert.equal(
      drained,
      '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]:\n1. now-1\n2. next-1\n3. next-2\n4. later-1\n5. later-2',
    )
    assert.equal(buf.hasPending(), false)
  })

  it('drain(maxPriority) leaves lower-priority items queued', () => {
    const buf = new SteerBuffer()
    buf.pushNow('now-1')
    buf.pushNext('next-1')
    buf.push('later-1')

    assert.equal(buf.drain('next'), '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]:\n1. now-1\n2. next-1')
    assert.equal(buf.hasPending(), true)
    assert.deepEqual([...buf.getPending()], ['later-1'])

    assert.equal(buf.drain('later'), '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]: later-1')
    assert.equal(buf.hasPending(), false)
  })

  it('peek returns highest-priority text without draining', () => {
    const buf = new SteerBuffer()
    buf.push('later-1')
    buf.pushNext('next-1')
    assert.equal(buf.peek(), 'next-1')
    assert.equal(buf.hasPending(), true)
  })

  it('hasPending(maxPriority) ignores lower-priority items', () => {
    const buf = new SteerBuffer()
    buf.push('later-1')
    assert.equal(buf.hasPending('now'), false)
    assert.equal(buf.hasPending('next'), false)
    assert.equal(buf.hasPending('later'), true)

    buf.pushNext('next-1')
    assert.equal(buf.hasPending('now'), false)
    assert.equal(buf.hasPending('next'), true)
  })

  it('all-guidance drain stays byte-identical to legacy format', () => {
    const buf = new SteerBuffer()
    buf.push('focus on performance')
    assert.equal(
      buf.drain(),
      '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]: focus on performance',
    )
  })

  it('halt elevates to now and tags drain with action tip', () => {
    const buf = new SteerBuffer()
    buf.push('later guidance')
    buf.push('停')
    const drained = buf.drain()
    assert.ok(drained?.startsWith('[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]:'))
    assert.ok(drained?.includes('1. [halt] 停'), 'halt first after elevate')
    assert.ok(drained?.includes('2. [guidance] later guidance'))
    assert.ok(drained?.endsWith('立即停下当前动作，等用户明确后再继续'))
  })

  it('pushNow skips classification — stays guidance at now', () => {
    const buf = new SteerBuffer()
    buf.pushNow('停') // would be halt if classified
    const entries = buf.getPendingEntries()
    assert.equal(entries[0]!.intent, 'guidance')
    assert.equal(entries[0]!.priority, 'now')
    // all-guidance → legacy byte format (no tags)
    assert.equal(
      buf.drain(),
      '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]: 停',
    )
  })

  it('drain(maxPriority) action tip uses drained subset only', () => {
    const buf = new SteerBuffer()
    buf.push('停') // elevates to now / halt
    buf.push('为什么选这个') // question at later
    // Drain only now — tip must be halt, not influenced by queued question
    const first = buf.drain('now')
    assert.ok(first?.includes('[halt] 停'))
    assert.ok(first?.endsWith('立即停下当前动作，等用户明确后再继续'))
    assert.ok(!first?.includes('question'))
    // Remaining question drains with its own tip
    const second = buf.drain()
    assert.ok(second?.includes('[question]'))
    assert.ok(second?.endsWith('先回答问题；除非答案要求，不改变当前任务方向'))
  })

  it('redirect elevates to next', () => {
    const buf = new SteerBuffer()
    buf.push('换个思路')
    const e = buf.getPendingEntries()[0]!
    assert.equal(e.intent, 'redirect')
    assert.equal(e.priority, 'next')
  })

  it('shift 按 FIFO 取出原文，不包 [User guidance]', () => {
    const buf = new SteerBuffer()
    buf.push('note 1')
    buf.push('note 2')
    assert.equal(buf.shift(), 'note 1')
    assert.deepEqual([...buf.getPending()], ['note 2'])
    assert.equal(buf.shift(), 'note 2')
    assert.equal(buf.shift(), null)
    assert.equal(buf.hasPending(), false)
  })
})
