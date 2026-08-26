import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  TimeoutReason, clampTimeout, deadline, idleWatchdog, timeoutOf,
} from '../timeout.js'

const tick = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

describe('timeout: clampTimeout', () => {
  test('min(requested ?? def, max) 三态', () => {
    assert.equal(clampTimeout(undefined, 5000, 30000), 5000, '缺省用默认')
    assert.equal(clampTimeout(2000, 5000, 30000), 2000, '请求值优先')
    assert.equal(clampTimeout(60000, 5000, 30000), 30000, '超上限被钳到 max')
  })
  test('非正/非有限请求值抛错（0 不是关闭哨兵）', () => {
    assert.throws(() => clampTimeout(0, 1000, 30000))
    assert.throws(() => clampTimeout(-5, 1000, 30000))
    assert.throws(() => clampTimeout(Number.NaN, 1000, 30000))
    assert.throws(() => clampTimeout(Number.POSITIVE_INFINITY, 1000, 30000))
  })
})

describe('timeout: deadline', () => {
  test('超时先赢：signal 带_timeout 的 TimeoutReason（code 与 timeoutMs 齐全）', async () => {
    const d = deadline(undefined, 20, 'TEST_TIMEOUT')
    try {
      await new Promise((_, reject) => d.signal.addEventListener('abort', () => reject(d.signal.reason)))
      assert.fail('should have thrown')
    } catch (reason) {
      const t = timeoutOf({ reason } as { reason?: unknown })
      assert.ok(t instanceof TimeoutReason)
      assert.equal(t!.code, 'TEST_TIMEOUT')
      assert.equal(t!.timeoutMs, 20)
    } finally {
      d[Symbol.dispose]()
    }
  })
  test('上游先赢：reason 保持普通 abort reason，timeoutOf 返回 undefined', async () => {
    const up = new AbortController()
    const d = deadline(up.signal, 10_000, 'TEST_TIMEOUT')
    up.abort('caller')
    assert.equal(d.signal.reason, 'caller')
    assert.equal(timeoutOf(d.signal), undefined)
    d[Symbol.dispose]()
  })
  test('dispose 清表：超时窗过后信号不再触发', async () => {
    const d = deadline(undefined, 20, 'TEST_TIMEOUT')
    d[Symbol.dispose]()
    await tick(50)
    assert.equal(d.signal.aborted, false)
  })
  test('timeoutMs<=0 = 无超时哨兵：只透传上游信号', () => {
    const up = new AbortController()
    const d = deadline(up.signal, 0, 'TEST_TIMEOUT')
    assert.equal(d.signal, up.signal)
    const none = deadline(undefined, -1, 'TEST_TIMEOUT')
    assert.equal(none.signal.aborted, false)
  })
})

describe('timeout: idleWatchdog', () => {
  test('空闲超窗触发：iterator 悬挂时 signal 带 TimeoutReason', async () => {
    const wd = idleWatchdog(undefined, 25, 'IDLE_TIMEOUT')
    // 悬挂的 iterator：next 永不 resolve
    const hanging: AsyncIterator<number> = { next: () => new Promise<IteratorResult<number>>(() => {}) }
    const pending = wd.next(hanging)
    await tick(50)
    assert.ok(wd.signal.aborted, '空闲超窗应触发 signal')
    const t = timeoutOf(wd.signal, 'IDLE_TIMEOUT')
    assert.ok(t, 'reason 应是 IdleTimeout 的 TimeoutReason')
    wd[Symbol.dispose]()
    void pending.catch(() => {})
  })
  test('pulse 续命：传输活动重挂计时器，不误杀活跃流', async () => {
    const wd = idleWatchdog(undefined, 40, 'IDLE_TIMEOUT')
    let resolveNext: ((v: IteratorResult<number>) => void) | undefined
    const slow: AsyncIterator<number> = { next: () => new Promise<IteratorResult<number>>(r => { resolveNext = r }) }
    const pending = wd.next(slow)
    // 每隔 20ms pulse 一次，共 100ms——远超 40ms 窗但没有一次真空闲到窗
    for (let i = 0; i < 5; i++) {
      await tick(20)
      wd.pulse()
    }
    assert.equal(wd.signal.aborted, false, '持续 pulse 不应触发')
    resolveNext?.({ done: true, value: undefined })
    await pending
    wd[Symbol.dispose]()
  })
  test('消费间隙不计时：无 outstanding demand 时窗口关闭', async () => {
    const wd = idleWatchdog(undefined, 25, 'IDLE_TIMEOUT')
    const quick: AsyncIterator<number> = {
      next: () => Promise.resolve<IteratorResult<number>>({ done: false, value: 1 }),
    }
    await wd.next(quick)
    // next 已结算（finally 清表）——静置远超窗也不触发
    await tick(60)
    assert.equal(wd.signal.aborted, false)
    wd[Symbol.dispose]()
  })
  test('dispose 后 next 抛错；并发 next 拒绝', async () => {
    const wd = idleWatchdog(undefined, 1000, 'IDLE')
    wd[Symbol.dispose]()
    await assert.rejects(() => wd.next({ next: () => Promise.resolve({ done: true } as IteratorResult<number>) }), /disposed/)
    const wd2 = idleWatchdog(undefined, 1000, 'IDLE')
    const hang: AsyncIterator<number> = { next: () => new Promise<IteratorResult<number>>(() => {}) }
    const p = wd2.next(hang)
    await assert.rejects(() => wd2.next(hang), /already outstanding/)
    wd2[Symbol.dispose]()
    void p.catch(() => {})
  })
})

describe('timeout: timeoutOf 归因', () => {
  test('code 过滤：只认自己的超时，嵌套上游的超时走普通取消路径', () => {
    const inner = new TimeoutReason('INNER', 100)
    assert.equal(timeoutOf({ reason: inner }, 'OUTER'), undefined, '外层不认内层的超时')
    assert.equal(timeoutOf({ reason: inner }, 'INNER'), inner)
    assert.equal(timeoutOf({ reason: inner }), inner, '无 code 时认任意 TimeoutReason')
    assert.equal(timeoutOf({ reason: new Error('x') }), undefined)
    assert.equal(timeoutOf({ reason: undefined }), undefined)
  })
})
