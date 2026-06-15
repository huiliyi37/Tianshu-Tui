import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme } from '../../theme.js'
import { buildWorkerFleetLines, formatWorkerFleet } from '../worker-fleet.js'
import type { FleetWorkerView } from '../../fleet-registry.js'

const theme = getTheme(0)

function worker(over: Partial<FleetWorkerView> = {}): FleetWorkerView {
  return {
    workerId: 'wo_team:T1',
    shortLabel: 'T1',
    parentToolId: 'tool_a',
    profile: 'reviewer',
    status: 'running',
    panelStatus: 'running',
    terminal: false,
    activity: '⚙ read_file',
    elapsedMs: 2000,
    ...over,
  }
}

describe('buildWorkerFleetLines', () => {
  it('单 worker：汇总头 + 行含标签/活动/elapsed', () => {
    const lines = buildWorkerFleetLines([worker()], { done: 0, total: 2, running: 1 }, 80)
    assert.equal(lines.length, 2)
    assert.ok(lines[0]!.includes('子代理'))
    assert.ok(lines[0]!.includes('0/2'))
    assert.ok(lines[0]!.includes('1↻'))
    assert.ok(lines[1]!.includes('T1·reviewer'))
    assert.ok(lines[1]!.includes('read_file'))
    assert.ok(lines[1]!.includes('2s'))
  })

  it('无 summary：头显示 ×N', () => {
    const lines = buildWorkerFleetLines([worker(), worker({ workerId: 'wo:T2', shortLabel: 'T2' })], undefined, 80)
    assert.ok(lines[0]!.includes('×2'))
  })

  it('多 worker 超 maxRows：折叠 …(+N)', () => {
    const workers = Array.from({ length: 9 }, (_, i) => worker({ workerId: `w${i}`, shortLabel: `T${i}` }))
    const lines = buildWorkerFleetLines(workers, { done: 0, total: 9, running: 9 }, 80, 6)
    // 头 + 6 行 + 折叠行
    assert.equal(lines.length, 8)
    assert.ok(lines[lines.length - 1]!.includes('(+3)'))
  })

  it('状态 glyph：passed/failed/blocked/escalated', () => {
    const statuses: FleetWorkerView['status'][] = ['passed', 'failed', 'blocked', 'escalated']
    for (const s of statuses) {
      const lines = buildWorkerFleetLines([worker({ status: s, activity: undefined })], undefined, 80)
      assert.ok(lines[1]!.match(/[✓✗⊗↑]/), `status ${s} 应有 glyph`)
    }
  })
})

describe('formatWorkerFleet', () => {
  it('行数与 plain 一致（头 + worker 行 + 折叠）', () => {
    const workers = [worker(), worker({ workerId: 'w2', shortLabel: 'T2', status: 'passed' })]
    const colored = formatWorkerFleet(workers, theme, 80, { done: 1, total: 2, running: 1 })
    const plain = buildWorkerFleetLines(workers, { done: 1, total: 2, running: 1 }, 80)
    assert.equal(colored.length, plain.length)
  })

  it('溢出行也被着色', () => {
    const workers = Array.from({ length: 8 }, (_, i) => worker({ workerId: `w${i}`, shortLabel: `T${i}` }))
    const colored = formatWorkerFleet(workers, theme, 80, { done: 0, total: 8, running: 8 }, 6)
    // 头 + 6 + overflow = 8
    assert.equal(colored.length, 8)
  })
})
