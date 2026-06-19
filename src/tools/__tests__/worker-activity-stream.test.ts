/**
 * T9 P3 实时上行: activity streamer 把 worker 原始活动事件折叠为
 * 有界的进度行 —— tool_use / tool_result 全量上行（有意义的进度拍点），
 * text/thinking 首次一行后静默（不再刷 deltas 计数）。
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

  it('text: 首个 delta 输出一行「写作中」，之后静默', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'text', detail: 'x' }))
    stream(ev({ kind: 'text', detail: 'y' }))
    stream(ev({ kind: 'text', detail: 'z' }))
    // 只有首次输出一行，后续不再刷屏
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /写作中/)
  })

  it('tool_result 输出完成行', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'tool_result', detail: 'read_file' }))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /完成/)
  })

  it('per work order 独立追踪 text 首次标志', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ workOrderId: 'wo_a', kind: 'text' }))
    stream(ev({ workOrderId: 'wo_b', kind: 'text' }))
    // 两个 worker 各自首次 text → 两行
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /\ba·/)
    assert.match(lines[1]!, /\bb·/)
  })

  it('thinking: 首次输出「思考中」', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'thinking', workOrderId: 'wo_x' }))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /思考中/)
  })
})
