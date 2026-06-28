import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { WriteStream } from 'node:tty'
import { ResizeHandler } from '../resize-handler.js'

function fakeStdout(cols = 80, rows = 24): WriteStream & { columns: number; rows: number } {
  const ee = new EventEmitter() as unknown as WriteStream & { columns: number; rows: number }
  ee.columns = cols
  ee.rows = rows
  return ee
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('ResizeHandler (trailing-edge debounce)', () => {
  it('coalesces a burst of resize events into a single trailing callback', async () => {
    const out = fakeStdout(80, 24)
    const h = new ResizeHandler({ stdout: out, debounceMs: 20, pollMs: 0 })
    const calls: Array<[number, number]> = []
    h.onResize((c, r) => calls.push([c, r]))

    out.columns = 120
    out.rows = 40
    out.emit('resize')
    out.emit('resize')
    out.emit('resize')
    assert.equal(calls.length, 0, 'must not fire on the leading edge')

    await sleep(40)
    assert.equal(calls.length, 1, 'exactly one trailing callback after the burst settles')
    assert.deepEqual(calls[0], [120, 40], 'reports the settled size')
    h.dispose()
  })

  it('does not fire when the settled size is unchanged', async () => {
    const out = fakeStdout(80, 24)
    const h = new ResizeHandler({ stdout: out, debounceMs: 20, pollMs: 0 })
    let calls = 0
    h.onResize(() => { calls++ })

    // emit without changing columns/rows
    out.emit('resize')
    await sleep(40)
    assert.equal(calls, 0, 'no size change → no callback')
    h.dispose()
  })

  it('dispose() clears a pending timer so no callback fires after teardown', async () => {
    const out = fakeStdout(80, 24)
    const h = new ResizeHandler({ stdout: out, debounceMs: 20, pollMs: 0 })
    let calls = 0
    h.onResize(() => { calls++ })

    out.columns = 100
    out.emit('resize')
    h.dispose() // before the debounce window elapses
    await sleep(40)
    assert.equal(calls, 0, 'disposed handler must not fire its pending callback')
    // dispose also detaches the listener: further events are inert.
    out.columns = 130
    out.emit('resize')
    await sleep(40)
    assert.equal(calls, 0, 'no callback after dispose detaches the listener')
  })

  it('getSize() reflects the live stdout dimensions', () => {
    const out = fakeStdout(90, 30)
    const h = new ResizeHandler({ stdout: out, pollMs: 0 })
    assert.deepEqual(h.getSize(), { cols: 90, rows: 30 })
    out.columns = 200
    assert.deepEqual(h.getSize(), { cols: 200, rows: 30 })
    h.dispose()
  })

  it('polling fallback fires when dimensions change without a resize event', async () => {
    // 某些多路复用器下 'resize' 事件不触发；轮询兜底应仍能捕获尺寸变化。
    const out = fakeStdout(80, 24)
    const h = new ResizeHandler({ stdout: out, debounceMs: 20, pollMs: 30 })
    const calls: Array<[number, number]> = []
    h.onResize((c, r) => calls.push([c, r]))

    // 不 emit 'resize'，只改尺寸 —— 模拟事件丢失场景
    out.columns = 140
    out.rows = 50

    // pollMs=30 + debounceMs=20：最多 ~60ms 后应触发
    await sleep(120)
    assert.ok(calls.length >= 1, `polling must detect size change without event: ${JSON.stringify(calls)}`)
    assert.deepEqual(calls[calls.length - 1], [140, 50], 'reports the polled size')
    h.dispose()
  })
})
