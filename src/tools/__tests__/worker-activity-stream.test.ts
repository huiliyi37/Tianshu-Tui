/**
 * T9 P3 实时上行: activity streamer 把 worker 原始活动事件折叠为
 * 有界的进度行 —— tool_use 全量上行（有意义的进度拍点），
 * text/thinking 折叠（首个 delta 一行，之后每 N 个一行心跳）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createActivityStreamer, shortOrderLabel } from '../worker-activity-stream.js'
import type { WorkerActivityEvent } from '../../agent/coordinator.js'

function ev(over: Partial<WorkerActivityEvent>): WorkerActivityEvent {
  return { workOrderId: 'wo_abc', profile: 'code_scout', kind: 'text', ...over }
}

describe('shortOrderLabel', () => {
  it('strips wo_ prefix and takes the last colon segment', () => {
    assert.equal(shortOrderLabel('wo_abc123'), 'abc123')
    assert.equal(shortOrderLabel('team:T1'), 'T1')
    assert.equal(shortOrderLabel('wo_team:T2'), 'T2')
  })
})

describe('createActivityStreamer', () => {
  it('emits a line for every tool_use with the tool name', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'tool_use', detail: 'read_file' }))
    stream(ev({ kind: 'tool_use', detail: 'grep' }))
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /abc·code_scout.*read_file/)
    assert.match(lines[1]!, /grep/)
  })

  it('collapses text deltas: first delta announces, then sparse heartbeats', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l), { textEvery: 10 })
    for (let i = 0; i < 25; i++) stream(ev({ kind: 'text', detail: 'x' }))
    // 1 announce (n=1) + heartbeats at n=10, n=20 → 3 lines for 25 deltas
    assert.equal(lines.length, 3)
    assert.match(lines[0]!, /输出中/)
    assert.match(lines[2]!, /20 deltas/)
  })

  it('tool_result events are silent (tool_use already covered the beat)', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'tool_result', detail: 'read_file' }))
    assert.equal(lines.length, 0)
  })

  it('tracks text counters per work order independently', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l), { textEvery: 100 })
    stream(ev({ workOrderId: 'wo_a', kind: 'text' }))
    stream(ev({ workOrderId: 'wo_b', kind: 'text' }))
    // Both first deltas announce — counters are per order, not global.
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /\ba·/)
    assert.match(lines[1]!, /\bb·/)
  })
})
