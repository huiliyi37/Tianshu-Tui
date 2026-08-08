/**
 * activity-store 测试 — AC1（归一投影 + 席位去重合并）与 AC2（每 item 恒 1 行 + 封顶折叠）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectFleet,
  projectCouncil,
  projectTeam,
  projectTodo,
  mergeActivityItems,
  buildActivityBandLines,
  councilSeatKey,
  councilRoundOf,
  COUNCIL_SEAT_PREFIX,
  type ActivityItem,
} from '../activity-store.js'
import type { FleetWorkerView } from '../fleet-registry.js'
import type { CouncilPanelModel } from '../council-panel-model.js'
import type { TeamPanelModel } from '../team-panel-model.js'
import type { TodoItem } from '../../tools/todo-store.js'
import { displayWidth } from '../width.js'

// ── fixtures ──────────────────────────────────────────────────────────

function worker(overrides: Partial<FleetWorkerView> & { workerId: string }): FleetWorkerView {
  return {
    shortLabel: overrides.workerId.split(':').pop() ?? overrides.workerId,
    parentToolId: 't1',
    profile: 'council_expert',
    status: 'running',
    panelStatus: 'running',
    terminal: false,
    activityLog: [],
    elapsedMs: 1000,
    toolUseCount: 2,
    tokenCount: 500,
    unread: false,
    ...overrides,
  }
}

function councilModel(seats: CouncilPanelModel['seats'], overrides?: Partial<CouncilPanelModel>): CouncilPanelModel {
  return {
    schemaVersion: 1,
    objective: '评审 X',
    seats,
    verdict: { accepted: 0, rejected: 0, deferred: 0, conflicts: 0 },
    pillarsMode: true,
    ...overrides,
  }
}

function teamModel(): TeamPanelModel {
  return {
    mode: 'standard',
    currentWave: 0,
    totalWaves: 2,
    dispatched: 2,
    blocked: [],
    // T2 依赖 T1，真实 DAG 里它属于第二波——每个任务都归属某一波，
    // 「任务不在任何 wave 里」是异常形态，单独由下面的边界用例覆盖。
    waves: [
      { id: 'w1', taskIds: ['T1'], risk: 'low', reason: 'r' },
      { id: 'w2', taskIds: ['T2'], risk: 'low', reason: 'r' },
    ],
    tasks: [
      {
        id: 'T1',
        title: '修认证 bug',
        authority: 'tianliang',
        profile: 'patcher',
        kind: 'patch',
        dependsOn: [],
        riskTier: 'low',
        files: [],
        status: 'running',
      },
      {
        id: 'T2',
        title: '回归验证',
        authority: 'yaoguang',
        profile: 'verifier',
        kind: 'verify',
        dependsOn: ['T1'],
        riskTier: 'low',
        files: [],
        status: 'waiting',
      },
    ],
  }
}

// ── council seat key / round ─────────────────────────────────────────

describe('councilSeatKey / councilRoundOf', () => {
  it('normalizes round-1 and suffixed variants to the same dedupe key', () => {
    assert.equal(councilSeatKey('council:seat-tianquan'), 'council:seat-tianquan')
    assert.equal(councilSeatKey('council:seat-tianquan-r2'), 'council:seat-tianquan')
    assert.equal(councilSeatKey('council:seat-tianquan-retry-reconvene'), 'council:seat-tianquan')
    assert.equal(councilSeatKey('wo_team:T1'), 'wo_team:T1')
  })

  it('parses round from -r2 suffix only', () => {
    assert.equal(councilRoundOf('council:seat-tianquan'), 1)
    assert.equal(councilRoundOf('council:seat-tianquan-r2'), 2)
    assert.equal(councilRoundOf('council:seat-tianquan-r2-retry'), 2)
    assert.equal(councilRoundOf('council:seat-tianquan-reconvene'), 1)
  })
})

// ── AC1: four projectors ─────────────────────────────────────────────

describe('projectFleet', () => {
  it('routes council seats vs plain agents by workOrderId prefix', () => {
    const items = projectFleet([
      worker({ workerId: 'council:seat-tianquan', authority: 'tianquan' }),
      worker({ workerId: 'batch:0', profile: 'patcher', authority: 'tianliang' }),
    ])
    assert.equal(items.length, 2)
    const seat = items.find(i => i.kind === 'council-seat')!
    assert.ok(seat)
    assert.equal(seat.groupId, 'council')
    assert.equal(seat.round, 1)
    assert.equal(seat.authority, 'tianquan')
    const agent = items.find(i => i.kind === 'agent')!
    assert.equal(agent.groupId, 'fleet')
    assert.equal(agent.id, 'batch:0')
  })

  it('maps -r2 seat to round 2 with a done terminal state', () => {
    const [seat] = projectFleet([worker({
      workerId: 'council:seat-yaoguang-r2',
      authority: 'yaoguang',
      status: 'passed',
      terminal: true,
      panelStatus: 'done',
    })])
    assert.equal(seat!.round, 2)
    assert.equal(seat!.status, 'done')
  })
})

describe('projectCouncil', () => {
  it('projects seats with modelUsed and round, id is the normalized key', () => {
    const items = projectCouncil(councilModel([
      { authority: 'tianquan', status: 'passed', round: 1, modelUsed: 'deepseek-v4' },
      { authority: 'tianji', status: 'running', round: 2 },
    ]))
    assert.equal(items.length, 2)
    assert.deepEqual(items.map(i => i.id), ['council:seat-tianquan', 'council:seat-tianji'])
    const tq = items[0]!
    assert.equal(tq.kind, 'council-seat')
    assert.equal(tq.modelUsed, 'deepseek-v4')
    assert.equal(tq.status, 'done')
    assert.equal(items[1]!.round, 2)
    assert.equal(items[1]!.status, 'running')
  })

  it('returns empty for null model', () => {
    assert.deepEqual(projectCouncil(null), [])
  })
})

describe('projectTeam', () => {
  it('projects tasks with phaseIndex from wave and subLabel identity', () => {
    const items = projectTeam(teamModel())
    assert.equal(items.length, 2)
    const t1 = items.find(i => i.id === 'T1')!
    assert.equal(t1.kind, 'team-task')
    assert.equal(t1.groupId, 'team')
    assert.equal(t1.phaseIndex, 0)
    assert.equal(t1.status, 'running')
    assert.equal(t1.label, '修认证 bug')
    const t2 = items.find(i => i.id === 'T2')!
    assert.equal(t2.status, 'pending')
    assert.equal(t2.phaseIndex, 1, '第二波的任务 phaseIndex 为 1')
  })

  it('任务不属于任何 wave 时 phaseIndex 缺席（不臆造 0）', () => {
    const model = teamModel()
    const orphaned: TeamPanelModel = { ...model, waves: [model.waves[0]!] }
    const t2 = projectTeam(orphaned).find(i => i.id === 'T2')!
    assert.equal(t2.phaseIndex, undefined, '无归属波次时不应回落成第 0 波')
  })

  it('returns empty for null model', () => {
    assert.deepEqual(projectTeam(null), [])
  })
})

describe('projectTodo', () => {
  it('prefers activeForm over content for the label', () => {
    const items = projectTodo([
      { id: '1', content: '修复认证 bug', status: 'in_progress', activeForm: '正在修认证 bug' },
      { id: '2', content: '写测试', status: 'pending' },
      { id: '3', content: '发版', status: 'completed' },
    ])
    assert.equal(items[0]!.label, '正在修认证 bug')
    assert.equal(items[0]!.status, 'running')
    assert.equal(items[1]!.label, '写测试')
    assert.equal(items[1]!.status, 'pending')
    assert.equal(items[2]!.status, 'done')
  })
})

// ── AC1: 席位不因双路径而重复 ────────────────────────────────────────

describe('mergeActivityItems', () => {
  it('dedupes council seats across fleet and council frame by normalized key', () => {
    const fleet = projectFleet([worker({
      workerId: 'council:seat-tianquan-r2',
      authority: 'tianquan',
      status: 'running',
      contract: { objective: '评审安全边界', profile: 'council_expert', scope: {}, constraints: [], budget: { maxTurns: 24, timeoutMs: 120000 }, allowedToolsDigest: 'read+2' },
    })])
    const frame = projectCouncil(councilModel([
      { authority: 'tianquan', status: 'running', round: 2, modelUsed: 'deepseek-v4' },
    ]))
    const merged = mergeActivityItems([fleet, frame])
    assert.equal(merged.length, 1)
    const seat = merged[0]!
    // fleet 的 label/round 保留，council 帧补 modelUsed
    assert.equal(seat.id, 'council:seat-tianquan')
    assert.equal(seat.round, 2)
    assert.equal(seat.modelUsed, 'deepseek-v4')
    assert.equal(seat.label, '评审安全边界')
  })

  it('keeps non-council items with distinct ids separate', () => {
    const merged = mergeActivityItems([
      projectFleet([worker({ workerId: 'batch:0', profile: 'patcher' })]),
      projectTodo([{ id: '1', content: 'c', status: 'pending' }]),
    ])
    assert.equal(merged.length, 2)
  })
})

// ── AC2: 每 item 恒 1 行 + 封顶折叠 ─────────────────────────────────

describe('buildActivityBandLines', () => {
  const bandItems: ActivityItem[] = [
    { id: 'council:seat-tianquan', kind: 'council-seat', label: '评审安全边界', status: 'running', groupId: 'council', round: 2 },
    { id: 'council:seat-tianji', kind: 'council-seat', label: '评审接口', status: 'done', groupId: 'council', modelUsed: 'deepseek-v4' },
    { id: 'batch:0', kind: 'agent', label: '修复 bug', status: 'running', groupId: 'fleet' },
    { id: 'T1', kind: 'team-task', label: '修认证 bug', status: 'running', groupId: 'team', phaseIndex: 0 },
    { id: '1', kind: 'todo', label: '写测试', status: 'pending', groupId: 'todo' },
  ]

  it('renders one group header + exactly one line per item', () => {
    const lines = buildActivityBandLines(bandItems, { maxRows: 10 })
    // 4 组头 + 5 item 行 = 9 行；组头与 item 交替排列（GROUP_ORDER 顺序）
    assert.equal(lines.length, 4 + 5)
    assert.match(lines[0]!, /◐ 议事会 · 1\/2 席/)
    assert.match(lines[1]!, / ├─ ◐ 评审安全边界/)
    assert.match(lines[2]!, / ├─ ✓ 评审接口/)
    assert.match(lines[3]!, /◐ 编队 · 1 执行中/)
    assert.match(lines[4]!, / ├─ ◐ 修认证 bug/)
    assert.match(lines[5]!, /◐ 1 子代理执行中/)
    assert.match(lines[6]!, / ├─ ◐ 修复 bug/)
    assert.match(lines[7]!, /◐ 待办 · 0\/1/)
    assert.match(lines[8]!, / ├─ ○ 写测试/)
  })

  it('caps items at maxRows and folds the rest as …(+N)', () => {
    const lines = buildActivityBandLines(bandItems, { maxRows: 2 })
    // 组头行不计入 maxRows 预算，item 行恒 1 行、封顶 2 行 + …(+3)
    const itemLines = lines.filter(l => /^ ├─/.test(l))
    assert.equal(itemLines.length, 2)
    assert.ok(lines[lines.length - 1]!.includes('…(+3)'))
  })

  it('each item occupies exactly one line — no embedded newlines', () => {
    const lines = buildActivityBandLines([
      { id: 'x', kind: 'agent', label: '多\n行\n标签', status: 'running', groupId: 'fleet' },
    ])
    assert.equal(lines.length, 2) // 头 + 1 item 行
    assert.ok(!lines[1]!.includes('\n'))
    assert.match(lines[1]!, /多 行 标签/) // 换行被压平
  })

  it('returns empty for no items', () => {
    assert.deepEqual(buildActivityBandLines([]), [])
  })

  it('renders council seat tail with round and modelUsed', () => {
    const lines = buildActivityBandLines([bandItems[0]!, bandItems[1]!], { maxRows: 10 })
    assert.match(lines[1]!, /r2/)
    assert.match(lines[2]!, /deepseek-v4/)
  })

  it('preserves round-2 seat identity even when prefix constant is used in ids', () => {
    const viaConst = `${COUNCIL_SEAT_PREFIX}tianquan`
    const lines = buildActivityBandLines([
      { id: viaConst, kind: 'council-seat', label: 'L', status: 'running', groupId: 'council' },
    ])
    assert.match(lines[1]!, /├─ ◐ L/)
  })
})
/**
 * band 的高度与宽度回归闸。
 *
 * 两条都踩过：组内 item 被折叠光后仍渲染孤零零的组头（白占一行且是纯噪音）；
 * 调用方漏传 width 时按默认 80 截断，窄终端上折行 → rowsForLine 少算 → 旧帧
 * 残留被顶进 scrollback。
 */
describe('formatActivityBand — 高度与宽度', () => {
  const group = (gid: 'council' | 'team' | 'fleet', n: number): ActivityItem[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `${gid}${i}`,
      kind: gid === 'council' ? 'council-seat' as const : gid === 'team' ? 'team-task' as const : 'agent' as const,
      label: `${gid} 项 ${i}`,
      status: 'running' as const,
      groupId: gid,
    }))

  it('预算耗尽的组不渲染空组头', () => {
    const items = [...group('council', 3), ...group('team', 3), ...group('fleet', 3)]
    const lines = buildActivityBandLines(items, { maxRows: 3, width: 80 })
    assert.ok(lines.some(l => l.includes('议事会')), '有预算的组渲染组头')
    assert.ok(!lines.some(l => l.includes('编队')), '预算耗尽的组不应留下孤组头')
    assert.ok(!lines.some(l => l.includes('子代理执行中')), '预算耗尽的组不应留下孤组头')
    assert.ok(lines.some(l => l.includes('…(+6)')), `折叠计数应含被跳过的整组: ${lines.join(' | ')}`)
    // 组头 1 + item 3 + 折叠 1
    assert.equal(lines.length, 5, `总行数: ${lines.join(' | ')}`)
  })

  it('总行数有界：组头只为有内容的组产出', () => {
    const items = [...group('council', 5), ...group('team', 5), ...group('fleet', 5)]
    const lines = buildActivityBandLines(items, { maxRows: 6, width: 80 })
    const headers = lines.filter(l => !l.includes('├─') && !l.includes('└─'))
    const itemLines = lines.filter(l => l.includes('├─'))
    assert.equal(itemLines.length, 6, 'item 行数等于 maxRows')
    assert.ok(headers.length <= 2, `15 项 / maxRows=6 时最多 2 个组有内容，实得 ${headers.length} 个组头`)
  })

  it('宽度账：显式 width 下不超（CJK 与省略号按 2 列）', () => {
    const long: ActivityItem[] = [{
      id: 'w1',
      kind: 'agent',
      label: '审查认证模块的令牌刷新逻辑与并发安全边界并给出完整的修复建议清单',
      status: 'running',
      groupId: 'fleet',
      subLabel: '天梁 · patcher',
      toolUseCount: 12,
      tokenCount: 45_000,
      elapsedMs: 90_000,
    }]
    for (const width of [40, 60, 80, 120]) {
      for (const line of buildActivityBandLines(long, { maxRows: 6, width })) {
        const limit = Math.min(Math.max(40, width), 80)
        assert.ok(
          displayWidth(line, { ambiguousAsWide: true }) <= limit,
          `width=${width} 超宽 ${displayWidth(line, { ambiguousAsWide: true })}>${limit}: ${line}`,
        )
      }
    }
  })
})
