/**
 * 子代理「完成沉淀卡」（formatWorkerFleetSettled）+ FleetRegistry.clearGroup
 * 返回值契约测试。
 *
 * 契约：
 *  1. clearGroup 把组内 worker 移入归档区并返回 { settled, evictedIds }——
 *     settled 为本组视图（首见时间升序），evictedIds 为归档区封顶淘汰的 id；
 *     无记录时两者皆空；归档后 /tasks 仍可查（getCompletedWorkers）。
 *  2. 沉淀卡头行聚合：通过数/总工具/总 token/最长耗时。
 *  3. 每 worker 一行与 live 树同构（├─/└─ + glyph + 标签 + 统计 + 耗时 + 摘要尾）。
 *  4. 超过 maxRows 折叠为 …(+N)；全通过 success 色，有失败 warning 色。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatWorkerFleetSettled } from '../format/worker-fleet.js'
import { FleetRegistry, type FleetWorkerView } from '../fleet-registry.js'
import { color } from '../engine/ansi.js'
import type { DelegationActivity } from '../../tools/types.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function view(partial: Partial<FleetWorkerView> & { workerId: string }): FleetWorkerView {
  return {
    shortLabel: partial.workerId,
    parentToolId: 'tool-1',
    profile: 'reviewer',
    status: 'completed',
    panelStatus: 'done',
    terminal: true,
    activityLog: [],
    elapsedMs: 65_000,
    toolUseCount: 20,
    tokenCount: 253_200,
    unread: true,
    ...partial,
  }
}

describe('formatWorkerFleetSettled', () => {
  it('头行聚合全组统计（通过数/总工具/总 token/最长耗时）', () => {
    const lines = formatWorkerFleetSettled([
      view({ workerId: 'w1', toolUseCount: 20, tokenCount: 253_200, elapsedMs: 60_000 }),
      view({ workerId: 'w2', toolUseCount: 30, tokenCount: 746_800, elapsedMs: 90_000 }),
    ], theme, 80)
    const plain = lines.map(stripAnsi)
    assert.ok(plain[0]!.includes('◆ 子代理组'), 'header')
    assert.ok(plain[0]!.includes('2/2 通过'), 'passed count')
    assert.ok(plain[0]!.includes('50 工具'), 'tools summed')
    assert.ok(plain[0]!.includes('1.0M tok'), 'tokens summed')
    assert.ok(plain[0]!.includes('1m30s'), 'max elapsed')
  })

  it('每 worker 一行：分支 glyph + 状态 glyph + 标签 + 摘要尾', () => {
    const lines = formatWorkerFleetSettled([
      view({ workerId: 'w1', profile: 'reviewer', activity: 'found 3 issues' }),
      view({ workerId: 'w2', profile: 'reviewer', status: 'failed', panelStatus: 'failed', activity: 'tests failed' }),
    ], theme, 80)
    const plain = lines.map(stripAnsi)
    assert.ok(plain[1]!.startsWith(' ├─ ✓'), 'first worker branch + pass glyph')
    assert.ok(plain[2]!.startsWith(' └─ ✗'), 'last worker end-branch + fail glyph')
    assert.ok(plain[1]!.includes('审查 #1'), 'profile label with seq (同 profile 多实例编号)')
    assert.ok(plain[1]!.includes('— found 3 issues'), 'summary tail')
    assert.ok(plain[2]!.includes('— tests failed'), 'failed summary tail')
  })

  it('超过 maxRows 折叠为 …(+N)，空组返回空数组', () => {
    const workers = Array.from({ length: 5 }, (_, i) => view({ workerId: `w${i}` }))
    const lines = formatWorkerFleetSettled(workers, theme, 80, 3).map(stripAnsi)
    assert.equal(lines.length, 1 + 3 + 1, 'header + 3 workers + overflow')
    assert.ok(lines[4]!.includes('…(+2)'), 'overflow row')
    assert.deepEqual(formatWorkerFleetSettled([], theme, 80), [], 'empty group → empty')
  })

  it('配色：全通过 success，有失败 warning（语义色单一来源）', () => {
    const ok = formatWorkerFleetSettled([view({ workerId: 'w1' })], theme, 80)
    const bad = formatWorkerFleetSettled([view({ workerId: 'w1', status: 'failed', panelStatus: 'failed' })], theme, 80)
    // 比对上色起始序列（chalk 闭合序列依赖被包裹文本，用哨兵字符切出 open 段）。
    const successOpen = color('', theme.success).split('')[0]!
    const warningOpen = color('', theme.warning).split('')[0]!
    assert.ok(ok[0]!.startsWith(successOpen), 'all-pass header opens with success color')
    assert.ok(bad[0]!.startsWith(warningOpen), 'failed header opens with warning color')
  })
})

describe('FleetRegistry.clearGroup 返回归档视图', () => {
  const act = (workOrderId: string, status: DelegationActivity['status'], extra: Partial<DelegationActivity> = {}): DelegationActivity => ({
    workOrderId,
    parentToolId: 'tool-1',
    profile: 'reviewer',
    status,
    ...extra,
  })

  it('返回本组 worker（首见升序），移入归档区后仍可查', () => {
    const fleet = new FleetRegistry()
    fleet.apply(act('w1', 'running'), 1000)
    fleet.apply(act('w2', 'running'), 2000)
    fleet.apply(act('w1', 'completed', { progressLine: 'done', toolUseCount: 20 }), 3000)
    fleet.apply(act('w2', 'failed', { progressLine: 'boom' }), 4000)

    const { settled } = fleet.clearGroup('tool-1', 5000)
    assert.equal(settled.length, 2)
    assert.equal(settled[0]!.workerId, 'w1', '首见升序')
    assert.equal(settled[1]!.workerId, 'w2')
    assert.equal(settled[0]!.toolUseCount, 20, '视图保留累计计数')
    assert.equal(settled[0]!.elapsedMs, 2000, '终态冻结 elapsed（updatedAt-startedAt）')
    assert.equal(fleet.getActiveWorkers().length, 0, 'active 区已清空')
    assert.equal(fleet.getCompletedWorkers().length, 2, '归档区仍可查（/tasks completed）')
  })

  it('无该组记录返回空数组；不影响其它组', () => {
    const fleet = new FleetRegistry()
    fleet.apply(act('w1', 'running'))
    assert.deepEqual(fleet.clearGroup('other-tool'), { settled: [], evictedIds: [] })
    assert.equal(fleet.getActiveWorkers().length, 1, '其它组 worker 不受影响')
  })
})

describe('FleetRegistry 终态重放防御', () => {
  const act = (workOrderId: string, status: DelegationActivity['status'], extra: Partial<DelegationActivity> = {}): DelegationActivity => ({
    workOrderId,
    parentToolId: 'tool-1',
    profile: 'reviewer',
    status,
    ...extra,
  })

  it('terminal→terminal 重放：elapsed 冻结在首次终态，unread 不重复标记', () => {
    const fleet = new FleetRegistry()
    fleet.apply(act('w1', 'running'), 1000)
    fleet.apply(act('w1', 'completed', { progressLine: 'done' }), 5000)
    fleet.markSeen('w1') // 用户已查看 → unread 清除
    // 批末兜底循环重放（带 usage/model 补齐）
    fleet.apply(act('w1', 'completed', { progressLine: 'done', usage: { input_tokens: 100, output_tokens: 50 }, model: 'm-x' }), 9000)
    const w = fleet.getWorkerById('w1', 10_000)!
    assert.equal(w.elapsedMs, 4000, 'elapsed 冻结在首次终态（5000-1000），不被重放推高')
    assert.equal(w.unread, false, '已读状态不被重放覆盖')
    assert.equal(w.model, 'm-x', '重放只补缺 model')
    assert.equal(w.usage?.input_tokens, 100, '重放只补缺 usage')
  })

  it('terminal→running→terminal（重跑）不受重放防御影响', () => {
    const fleet = new FleetRegistry()
    fleet.apply(act('w1', 'running'), 1000)
    fleet.apply(act('w1', 'failed'), 2000)
    fleet.apply(act('w1', 'running'), 3000) // 重跑
    fleet.apply(act('w1', 'completed'), 6000)
    const w = fleet.getWorkerById('w1', 7000)!
    assert.equal(w.status, 'completed')
    // 重跑起新记录，耗时按本轮计（6000-3000）。此前共用同一条记录时这里是
    // 5000（6000-1000），把首轮 1s 与两轮之间的空档一并算进了「这轮跑了多久」。
    assert.equal(w.elapsedMs, 3000, '耗时自本轮 startedAt 计，不跨轮累加')
    assert.equal(w.unread, true, '重跑的新终态重新标 unread')
  })
})
