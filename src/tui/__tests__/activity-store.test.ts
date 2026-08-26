/**
 * activity-store 测试 — AC1（归一投影 + 席位去重合并）与 AC2
 * （running 扁平行 + 统一计数头 + 最新 ⎿ + /tasks 尾行）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectFleet,
  projectCouncil,
  projectTeam,
  projectTodo,
  projectJobs,
  mergeActivityItems,
  buildActivityBandLines,
  formatJobsBar,
  councilSeatKey,
  councilRoundOf,
  COUNCIL_SEAT_PREFIX,
  ActivityStore,
  type ActivityItem,
} from '../activity-store.js'
import type { FleetWorkerView } from '../fleet-registry.js'
import type { CouncilPanelModel } from '../council-panel-model.js'
import type { TeamPanelModel } from '../team-panel-model.js'
import type { TodoItem } from '../../tools/todo-store.js'
import type { JobRow } from '../job-registry.js'
import { displayWidth } from '../width.js'
import { getTheme } from '../theme.js'
import { resetSpinnerConfig } from '../format/spinner-status.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

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

  it('forwards the latest activity line for the ⎿ 子行', () => {
    const [item] = projectFleet([worker({
      workerId: 'batch:0',
      profile: 'patcher',
      activity: '⚙ Read src/a.ts',
    })])
    assert.equal(item!.activity, '⚙ Read src/a.ts')
  })

  it('maps -r2 seat to round 2 with a done terminal state', () => {
    const [seat] = projectFleet([worker({
      workerId: 'council:seat-yaoguang-r2',
      authority: 'yaoguang',
      status: 'completed',
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

// ── 第五源：后台任务实时条 ──────────────────────────────────────────

describe('projectJobs / formatJobsBar', () => {
  const now = 1_000_000
  const jobRow = (overrides: Partial<JobRow> & { id: string }): JobRow => ({
    command: 'cmd',
    status: 'running',
    startedAt: now - 10_000,
    lastLine: '',
    terminal: false,
    unread: false,
    ...overrides,
  })

  it('无 running 时不产出 item（空数组 / 全终态）', () => {
    assert.deepEqual(projectJobs([], now), [])
    assert.deepEqual(projectJobs([
      jobRow({ id: 'a', status: 'exited', terminal: true, endedAt: now - 1000 }),
      jobRow({ id: 'b', status: 'killed', terminal: true, endedAt: now - 2000 }),
    ], now), [])
  })

  it('无 running 时 formatJobsBar 返回 null（不渲染）', () => {
    assert.equal(formatJobsBar([], theme), null)
  })

  it('有 running：计数、首个命令、elapsed 取最长', () => {
    // rows() 口径：running 组内 startedAt 新者在前——首个是 b（5s），最长是 a（1m30s）。
    const rows = [
      jobRow({ id: 'b', command: 'npm run dev', startedAt: now - 5_000 }),
      jobRow({ id: 'a', command: 'pytest -x', startedAt: now - 90_000 }),
      jobRow({ id: 'c', command: 'old', status: 'exited', terminal: true, endedAt: now - 60_000 }),
    ]
    const items = projectJobs(rows, now)
    assert.equal(items.length, 2, '终态不进投影')
    assert.equal(items[0]!.label, 'npm run dev')
    assert.equal(items[0]!.elapsedMs, 5_000)
    assert.equal(items[1]!.elapsedMs, 90_000)
    const bar = stripAnsi(formatJobsBar(items, theme)!)
    assert.ok(bar.includes('⚙ 2 后台任务'), bar)
    assert.ok(bar.includes('npm run dev'), `首个 running 命令: ${bar}`)
    assert.ok(bar.includes('1m30s'), `最长 elapsed（非首个的 5s）: ${bar}`)
  })

  it('命令压平空白换行', () => {
    const [item] = projectJobs([jobRow({ id: 'a', command: 'npm run\n  dev' })], now)
    assert.equal(item!.label, 'npm run dev')
  })

  it('ActivityStore.setJobs → projectJobs 独立出口，clear 复位', () => {
    const store = new ActivityStore()
    assert.equal(store.projectJobs().length, 0)
    store.setJobs([jobRow({ id: 'a', command: 'npm run dev' })], now)
    const items = store.projectJobs()
    assert.equal(items.length, 1)
    assert.equal(items[0]!.kind, 'background-job')
    assert.equal(items[0]!.groupId, 'jobs')
    // 独立出口：不进 project() 合并（band 不出现 jobs 组）
    assert.ok(!store.project().some(i => i.groupId === 'jobs'))
    store.clear()
    assert.equal(store.projectJobs().length, 0)
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
    { id: 'council:seat-tianquan', kind: 'council-seat', label: '评审安全边界', status: 'running', groupId: 'council', round: 2, elapsedMs: 3000 },
    { id: 'council:seat-tianji', kind: 'council-seat', label: '评审接口', status: 'done', groupId: 'council', modelUsed: 'deepseek-v4' },
    { id: 'batch:0', kind: 'agent', label: '修复 bug', status: 'running', groupId: 'fleet', elapsedMs: 1000, toolUseCount: 2, tokenCount: 1200, activity: '⚙ Read src/a.ts' },
    { id: 'T1', kind: 'team-task', label: '修认证 bug', status: 'running', groupId: 'team', phaseIndex: 0, elapsedMs: 2000 },
    { id: '1', kind: 'todo', label: '写测试', status: 'pending', groupId: 'todo' },
  ]

  it('只渲染 running：统一计数头 + 每 item 1 行 + 最新子代理 ⎿ + /tasks 尾行', () => {
    const lines = buildActivityBandLines(bandItems, { maxRows: 10 })
    assert.ok(lines[0]!.includes('◐ 1 子代理 · 1 编队 · 1 席'), `计数头: ${lines[0]}`)
    assert.ok(!lines.some(l => l.includes('├─')), '不再用树形前缀')
    assert.ok(!lines.some(l => l.includes('评审接口') || l.includes('写测试')), 'done/pending 不进带')
    assert.ok(lines.some(l => l.includes('修复 bug')), 'running 子代理在列')
    assert.ok(lines.some(l => l.includes('修认证 bug')), 'running 编队在列')
    assert.ok(lines.some(l => l.includes('评审安全边界')), 'running 席在列')
    assert.ok(lines.some(l => l.includes('⎿') && l.includes('Read src/a.ts')), '最新子代理挂 ⎿')
    assert.equal(lines[lines.length - 1], '/tasks 管理')
  })

  it('caps items at maxRows and folds the rest as …(+N) · /tasks', () => {
    const lines = buildActivityBandLines(bandItems, { maxRows: 2 })
    const itemLines = lines.filter(l => l.includes('修复 bug') || l.includes('修认证 bug') || l.includes('评审安全边界'))
    assert.equal(itemLines.length, 2)
    assert.ok(lines[lines.length - 1]!.includes('…(+1)'), `折叠: ${lines[lines.length - 1]}`)
    assert.ok(lines[lines.length - 1]!.includes('/tasks 管理'))
  })

  it('each item occupies exactly one line — no embedded newlines', () => {
    const lines = buildActivityBandLines([
      { id: 'x', kind: 'agent', label: '多\n行\n标签', status: 'running', groupId: 'fleet' },
    ])
    // 单条 running：无计数头；无 activity/toolUseCount → 无 ⎿；恒有尾行
    assert.equal(lines.length, 2)
    assert.ok(!lines[0]!.includes('\n'))
    assert.match(lines[0]!, /多 行 标签/)
    assert.equal(lines[1], '/tasks 管理')
  })

  it('returns empty for no items', () => {
    assert.deepEqual(buildActivityBandLines([]), [])
  })

  it('done-only 输入不渲染带（终态已进 scrollback）', () => {
    assert.deepEqual(buildActivityBandLines([
      { id: 'd', kind: 'agent', label: '已完成', status: 'done', groupId: 'fleet' },
    ]), [])
  })

  it('renders running council seat tail with round and modelUsed', () => {
    const lines = buildActivityBandLines([
      { id: 'council:seat-tianquan', kind: 'council-seat', label: '评审安全边界', status: 'running', groupId: 'council', round: 2, modelUsed: 'deepseek-v4', elapsedMs: 4000 },
    ], { maxRows: 10 })
    const row = lines.find(l => l.includes('评审安全边界'))!
    assert.match(row, /r2/)
    assert.match(row, /deepseek-v4/)
  })

  it('preserves round-2 seat identity even when prefix constant is used in ids', () => {
    const viaConst = `${COUNCIL_SEAT_PREFIX}tianquan`
    const lines = buildActivityBandLines([
      { id: viaConst, kind: 'council-seat', label: 'L', status: 'running', groupId: 'council' },
    ])
    assert.match(lines[0]!, / L/)
    assert.ok(!lines[0]!.includes('├─'))
  })

  it('零工具且无活动行时挂 ⎿ 启动中…', () => {
    const lines = buildActivityBandLines([
      { id: 'w1', kind: 'agent', label: '侦察', status: 'running', groupId: 'fleet', toolUseCount: 0 },
    ])
    assert.ok(lines.some(l => l.includes('⎿') && l.includes('启动中…')), lines.join(' | '))
  })

  it('spinner 随 tick 换帧；后缀从右丢', () => {
    resetSpinnerConfig()
    const item: ActivityItem = {
      id: 'w1',
      kind: 'agent',
      label: '审查认证模块',
      status: 'running',
      groupId: 'fleet',
      toolUseCount: 12,
      tokenCount: 45_000,
      elapsedMs: 90_000,
    }
    const a = buildActivityBandLines([item], { tick: 0, width: 80 })[0]!
    const b = buildActivityBandLines([item], { tick: 1, width: 80 })[0]!
    assert.notEqual(a[1], b[1], `glyph 应随 tick 变: ${a} vs ${b}`)
    const narrow = buildActivityBandLines([item], { tick: 0, width: 28 })[0]!
    assert.ok(narrow.includes('12 工具'), `工具段优先保留: ${narrow}`)
    assert.ok(!narrow.includes('1m30s') && !narrow.includes('90'), `窄宽丢掉右侧耗时: ${narrow}`)
  })
})
/**
 * band 的高度与宽度回归闸。
 *
 * 计数头只一条（按 kind 汇总，含被折叠组）；超 maxRows 折进尾行，不留空组头。
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
      elapsedMs: (n - i) * 1000,
    }))

  it('超封顶折叠进尾行，不留空组头', () => {
    const items = [...group('council', 3), ...group('team', 3), ...group('fleet', 3)]
    const lines = buildActivityBandLines(items, { maxRows: 3, width: 80 })
    assert.ok(lines[0]!.includes('3 子代理') && lines[0]!.includes('3 编队') && lines[0]!.includes('3 席'), `统一计数头含被折叠组: ${lines[0]}`)
    assert.ok(lines.some(l => l.includes('…(+6)')), `折叠计数应含被截断项: ${lines.join(' | ')}`)
    // 头 + 3 item +（最新 agent 可能 ⎿）+ 折叠尾行
    assert.ok(lines.length <= 1 + 3 + 1 + 1, `总行数有界: ${lines.join(' | ')}`)
    assert.equal(lines.filter(l => l.includes('项 ')).length, 3)
  })

  it('总行数有界：计数头最多 1 行，item 行数等于 maxRows', () => {
    const items = [...group('council', 5), ...group('team', 5), ...group('fleet', 5)]
    const lines = buildActivityBandLines(items, { maxRows: 6, width: 80 })
    const headers = lines.filter(l => l.includes('◐'))
    const itemLines = lines.filter(l => /项 \d/.test(l))
    assert.equal(itemLines.length, 6, 'item 行数等于 maxRows')
    assert.equal(headers.length, 1, `只一条统一计数头，实得 ${headers.length}`)
    assert.ok(lines[lines.length - 1]!.includes('/tasks'))
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
        assert.ok(
          displayWidth(line, { ambiguousAsWide: true }) <= width,
          `width=${width} 超宽 ${displayWidth(line, { ambiguousAsWide: true })}>${width}: ${line}`,
        )
      }
    }
  })
})
