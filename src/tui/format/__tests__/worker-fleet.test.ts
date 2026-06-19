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
    profile: 'code_scout',
    status: 'running',
    panelStatus: 'running',
    terminal: false,
    activity: '⚙ read_file',
    elapsedMs: 2000,
    ...over,
  }
}

describe('buildWorkerFleetLines', () => {
  it('单 worker：汇总头 + 行含中文职能名/活动/elapsed', () => {
    const lines = buildWorkerFleetLines([worker()], { done: 0, total: 2, running: 1 }, 80)
    assert.equal(lines.length, 2)
    assert.ok(lines[0]!.includes('子代理'))
    assert.ok(lines[0]!.includes('执行中'))
    // 不再包含英文 profile
    assert.ok(!lines[0]!.includes('Agents'))
    assert.ok(lines[1]!.includes('侦察'))
    assert.ok(lines[1]!.includes('代码'))
    assert.ok(lines[1]!.includes('read_file'))
    assert.ok(lines[1]!.includes('2s'))
  })

  it('无 summary：头显示 N 执行中', () => {
    const lines = buildWorkerFleetLines([worker(), worker({ workerId: 'wo:T2', shortLabel: 'T2' })], undefined, 80)
    assert.ok(lines[0]!.includes('2 执行中'))
  })

  it('不再显示 UUID 前缀或英文 profile 名', () => {
    const lines = buildWorkerFleetLines([worker()], undefined, 80)
    assert.ok(!lines[1]!.includes('code_scout'))
    assert.ok(!lines[1]!.includes('T1·'))
    // 中文职能名应出现
    assert.ok(lines[1]!.includes('侦察·代码'))
  })

  it('同 profile 多 worker 显示序号 #1/#2', () => {
    const w1 = worker({ workerId: 'w1', shortLabel: 'W1' })
    const w2 = worker({ workerId: 'w2', shortLabel: 'W2' })
    const lines = buildWorkerFleetLines([w1, w2], undefined, 80)
    assert.ok(lines[1]!.includes('#1'))
    assert.ok(lines[2]!.includes('#2'))
  })

  it('不同 profile 不显示序号', () => {
    const w1 = worker({ workerId: 'w1', shortLabel: 'W1', profile: 'code_scout' })
    const w2 = worker({ workerId: 'w2', shortLabel: 'W2', profile: 'doc_scout' })
    const lines = buildWorkerFleetLines([w1, w2], undefined, 80)
    assert.ok(!lines[1]!.includes('#1'))
    assert.ok(!lines[2]!.includes('#1'))
  })

  it('多 worker 超 maxRows：折叠 …(+N)', () => {
    const workers = Array.from({ length: 9 }, (_, i) => worker({ workerId: `w${i}`, shortLabel: `T${i}` }))
    const lines = buildWorkerFleetLines(workers, { done: 0, total: 9, running: 9 }, 80, 6)
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

  it('汇总头含完成数（有完成时）', () => {
    const lines = buildWorkerFleetLines(
      [worker({ status: 'passed', activity: undefined })],
      { done: 1, total: 2, running: 1 },
      80,
    )
    assert.ok(lines[0]!.includes('1/2 完成'))
  })

  it('有 authority 时显示星名前缀', () => {
    const lines = buildWorkerFleetLines(
      [worker({ authority: 'pojun' })],
      undefined,
      80,
    )
    assert.ok(lines[1]!.includes('破军'), '应有星名「破军」')
    assert.ok(lines[1]!.includes('侦察'), '应有职能名')
  })

  it('无 authority 时不显示星名（向后兼容）', () => {
    const lines = buildWorkerFleetLines(
      [worker({ authority: undefined })],
      undefined,
      80,
    )
    assert.ok(!lines[1]!.includes('破军'), '不应有星名')
    assert.ok(lines[1]!.includes('侦察'), '应有职能名')
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
    assert.equal(colored.length, 8)
  })
})
