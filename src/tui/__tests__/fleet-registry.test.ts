import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FleetRegistry } from '../fleet-registry.js'
import type { DelegationActivity } from '../../tools/types.js'

function running(workOrderId: string, parentToolId: string, profile?: string, progressLine?: string): DelegationActivity {
  return { workOrderId, parentToolId, profile, status: 'running', progressLine }
}

test('FleetRegistry: 首见 running 进入 active，elapsed 自 startedAt 计', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_team:T1', 'tool_a', 'reviewer', '⚙ read_file'), 1000)
  const active = fleet.getActiveWorkers(1500)
  assert.equal(active.length, 1)
  const w = active[0]!
  assert.equal(w.workerId, 'wo_team:T1')
  assert.equal(w.shortLabel, 'T1')
  assert.equal(w.parentToolId, 'tool_a')
  assert.equal(w.profile, 'reviewer')
  assert.equal(w.status, 'running')
  assert.equal(w.panelStatus, 'running')
  assert.equal(w.terminal, false)
  assert.equal(w.activity, '⚙ read_file')
  assert.equal(w.elapsedMs, 500)
})

test('FleetRegistry: running→terminal 归约，elapsed 在终态后冻结', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_x', 'tool_a', 'patcher'), 1000)
  fleet.apply({ workOrderId: 'wo_x', parentToolId: 'tool_a', status: 'passed', progressLine: 'done summary' }, 2000)
  // 终态 worker 不在 active 列表
  assert.equal(fleet.getActiveWorkers(9999).length, 0)
  const all = fleet.getWorkers(9999)
  assert.equal(all.length, 1)
  const w = all[0]!
  assert.equal(w.status, 'passed')
  assert.equal(w.panelStatus, 'done')
  assert.equal(w.terminal, true)
  // terminal 事件无 profile → 保留首见 profile
  assert.equal(w.profile, 'patcher')
  assert.equal(w.activity, 'done summary')
  // elapsed 冻结在 terminal updatedAt - startedAt（不随 now 增长）
  assert.equal(w.elapsedMs, 1000)
})

test('FleetRegistry: blocked/escalated 归入 failed panelStatus', () => {
  const fleet = new FleetRegistry()
  fleet.apply({ workOrderId: 'wo_b', parentToolId: 't', profile: 'p', status: 'blocked' }, 0)
  fleet.apply({ workOrderId: 'wo_e', parentToolId: 't', profile: 'p', status: 'escalated' }, 0)
  const views = fleet.getWorkers(0)
  assert.deepEqual(views.map(v => v.panelStatus).sort(), ['failed', 'failed'])
  assert.deepEqual(views.map(v => v.status).sort(), ['blocked', 'escalated'])
})

test('FleetRegistry: 分组进度按 parentToolId 计数派生', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo1', 'batchTool'), 0)
  fleet.apply(running('wo2', 'batchTool'), 0)
  fleet.apply(running('wo3', 'batchTool'), 0)
  fleet.apply({ workOrderId: 'wo1', parentToolId: 'batchTool', status: 'passed' }, 1)
  fleet.apply({ workOrderId: 'wo2', parentToolId: 'batchTool', status: 'blocked' }, 1)
  const prog = fleet.getGroupProgress('batchTool')
  assert.deepEqual(prog, { total: 3, done: 1, failed: 1, running: 1 })
})

test('FleetRegistry: 多组隔离 + getParentToolIds 保首见顺序', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('a1', 'toolA'), 0)
  fleet.apply(running('b1', 'toolB'), 1)
  fleet.apply(running('a2', 'toolA'), 2)
  assert.deepEqual(fleet.getParentToolIds(), ['toolA', 'toolB'])
  assert.equal(fleet.getGroupProgress('toolA').total, 2)
  assert.equal(fleet.getGroupProgress('toolB').total, 1)
})

test('FleetRegistry: clearGroup 仅清理目标组', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('a1', 'toolA'), 0)
  fleet.apply(running('b1', 'toolB'), 0)
  fleet.clearGroup('toolA')
  assert.equal(fleet.size, 1)
  assert.equal(fleet.getParentToolIds().length, 1)
  assert.equal(fleet.getParentToolIds()[0], 'toolB')
})

test('FleetRegistry: clearGroup 归档终态记录，仍可通过 getWorkerById 查询', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_x', 'toolA', 'patcher'), 0)
  fleet.apply({ workOrderId: 'wo_x', parentToolId: 'toolA', status: 'passed', progressLine: 'done' }, 100)
  fleet.clearGroup('toolA')
  assert.equal(fleet.size, 0)
  assert.equal(fleet.completedSize(), 1)
  const w = fleet.getWorkerById('wo_x', 200)
  assert.ok(w)
  assert.equal(w!.status, 'passed')
  assert.equal(w!.profile, 'patcher')
})

test('FleetRegistry: getCompletedWorkers / getAllWorkers 支持 filter', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_active', 'toolA'), 0)
  fleet.apply({ workOrderId: 'wo_done', parentToolId: 'toolA', status: 'passed' }, 0)
  assert.equal(fleet.getCompletedWorkers().length, 1)
  assert.equal(fleet.getAllWorkers(0, 'all').length, 2)
  assert.equal(fleet.getAllWorkers(0, 'active').length, 1)
  assert.equal(fleet.getAllWorkers(0, 'completed').length, 1)
})

test('FleetRegistry: hasActive 反映是否有未终态 worker', () => {
  const fleet = new FleetRegistry()
  assert.equal(fleet.hasActive(), false)
  fleet.apply(running('w', 't'), 0)
  assert.equal(fleet.hasActive(), true)
  fleet.apply({ workOrderId: 'w', parentToolId: 't', status: 'failed' }, 1)
  assert.equal(fleet.hasActive(), false)
})

test('FleetRegistry: toolUseCount/tokenCount 计数归约，只增不减', () => {
  const fleet = new FleetRegistry()
  fleet.apply({ ...running('wo_c', 't'), toolUseCount: 1 }, 0)
  fleet.apply({ ...running('wo_c', 't'), toolUseCount: 3, tokenCount: 1200 }, 1)
  // 乱序/迟到事件不回退计数
  fleet.apply({ ...running('wo_c', 't'), toolUseCount: 2, tokenCount: 800 }, 2)
  const w = fleet.getWorkerById('wo_c', 3)!
  assert.equal(w.toolUseCount, 3)
  assert.equal(w.tokenCount, 1200)
})

test('FleetRegistry: 终态 usage/model 保留，tokenCount 从 usage 派生并在归档后可查', () => {
  const fleet = new FleetRegistry()
  fleet.apply({ ...running('wo_u', 'toolA'), toolUseCount: 5, tokenCount: 2000 }, 0)
  fleet.apply({
    workOrderId: 'wo_u',
    parentToolId: 'toolA',
    status: 'passed',
    progressLine: 'done',
    model: 'deepseek-v4',
    usage: { input_tokens: 3000, output_tokens: 500, total_tokens: 3500 },
  }, 100)
  fleet.clearGroup('toolA')
  const w = fleet.getWorkerById('wo_u', 200)!
  assert.equal(w.terminal, true)
  assert.equal(w.model, 'deepseek-v4')
  assert.deepEqual(w.usage, { input_tokens: 3000, output_tokens: 500, total_tokens: 3500 })
  // usage.total_tokens > 运行中心跳 → tokenCount 升级为终态快照
  assert.equal(w.tokenCount, 3500)
  // 终态事件不带 toolUseCount → 保留运行中累计值
  assert.equal(w.toolUseCount, 5)
})

test('FleetRegistry: usage 缺 total_tokens 时 tokenCount 回退 input+output', () => {
  const fleet = new FleetRegistry()
  fleet.apply({
    workOrderId: 'wo_v',
    parentToolId: 't',
    status: 'passed',
    usage: { input_tokens: 100, output_tokens: 50 },
  }, 0)
  assert.equal(fleet.getWorkerById('wo_v', 1)!.tokenCount, 150)
})

test('FleetRegistry: getWorkers 按 startedAt 升序', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('late', 't'), 100)
  fleet.apply(running('early', 't'), 10)
  const ids = fleet.getWorkers(200).map(w => w.workerId)
  assert.deepEqual(ids, ['early', 'late'])
})
