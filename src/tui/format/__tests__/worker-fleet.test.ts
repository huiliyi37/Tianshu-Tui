import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme } from '../../theme.js'
import { displayWidth } from '../../width.js'
import { buildWorkerFleetLines, formatWorkerFleet, formatWorkerRow } from '../worker-fleet.js'
import type { FleetWorkerView } from '../../fleet-registry.js'
import type { ContractProjection } from '../../../agent/contract-projection.js'

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
    activityLog: [],
    elapsedMs: 2000,
    toolUseCount: 0,
    tokenCount: 0,
    unread: false,
    ...over,
  }
}

function contract(over: Partial<ContractProjection> = {}): ContractProjection {
  return {
    objective: '定位 /tasks 舰队行渲染函数',
    profile: 'code_scout',
    scope: {},
    constraints: [],
    budget: { maxTurns: 24, timeoutMs: 480000 },
    allowedToolsDigest: 'read+2',
    ...over,
  }
}

describe('buildWorkerFleetLines', () => {
  it('单 worker：汇总头 + 主行（身份/elapsed）+ 续行（身份·计数·状态）+ 提示', () => {
    const lines = buildWorkerFleetLines([worker()], { done: 0, total: 2, running: 1 }, 80)
    assert.equal(lines.length, 4) // 头 + 主行 + 续行 + 提示行
    assert.ok(lines[0]!.includes('子代理'))
    assert.ok(lines[0]!.includes('执行中'))
    assert.ok(!lines[0]!.includes('Agents'))
    // 主行：树形 glyph + 身份（无 objective 时回退）+ elapsed
    assert.ok(lines[1]!.includes('└─'))
    assert.ok(lines[1]!.includes('侦察'))
    assert.ok(lines[1]!.includes('代码'))
    assert.ok(lines[1]!.includes('2s'))
    // 续行：身份 · 计数 · 状态词
    assert.ok(lines[2]!.includes('侦察代码'))
    assert.ok(lines[2]!.includes('执行中'))
    // 提示行
    assert.ok(lines[3]!.includes('/tasks'))
  })

  it('计数段：toolUseCount/tokenCount 有值时在续行渲染，为零时省略', () => {
    const lines = buildWorkerFleetLines(
      [worker({ toolUseCount: 12, tokenCount: 3400 })],
      undefined,
      80,
    )
    // 续行（line[2]）：身份 + 12 工具 · 3.4k tok
    assert.ok(lines[2]!.includes('12 工具'))
    assert.ok(lines[2]!.includes('3.4k tok'))
    const bare = buildWorkerFleetLines([worker()], undefined, 80)
    assert.ok(!bare[2]!.includes('工具'))
    assert.ok(!bare[2]!.includes('tok'))
  })

  it('树形分支：多 worker 时非末支 ├─、末支 └─，续行用 │', () => {
    const w1 = worker({ workerId: 'w1', profile: 'code_scout' })
    const w2 = worker({ workerId: 'w2', profile: 'doc_scout' })
    const lines = buildWorkerFleetLines([w1, w2], undefined, 80)
    // header + (branch+continuation)*2 + 提示行 = 6
    assert.equal(lines.length, 6)
    assert.ok(lines[1]!.includes('├─'))
    assert.ok(lines[2]!.includes('│'), '非末支续行应有 │')
    assert.ok(lines[3]!.includes('└─'))
    assert.ok(!lines[4]!.includes('│'), '末支续行不应有 │')
  })

  it('无 summary：头显示 N 执行中', () => {
    const lines = buildWorkerFleetLines([worker(), worker({ workerId: 'wo:T2', shortLabel: 'T2' })], undefined, 80)
    assert.ok(lines[0]!.includes('2 执行中'))
  })

  it('不再显示 UUID 前缀或英文 profile 名', () => {
    const lines = buildWorkerFleetLines([worker()], undefined, 80)
    assert.ok(!lines[1]!.includes('code_scout'))
    assert.ok(!lines[1]!.includes('T1·'))
    // 中文职能名应出现（与 formatWorkerIdentity 同源的紧凑形，无中点）
    assert.ok(lines[1]!.includes('侦察代码'))
  })

  it('同 profile 多 worker 显示序号 #1/#2', () => {
    const w1 = worker({ workerId: 'w1', shortLabel: 'W1', activity: undefined })
    const w2 = worker({ workerId: 'w2', shortLabel: 'W2', activity: undefined })
    const lines = buildWorkerFleetLines([w1, w2], undefined, 80)
    // 新布局每 worker 2 行：lines[1] 是 w1 主行，lines[3] 是 w2 主行
    assert.ok(lines[1]!.includes('#1'))
    assert.ok(lines[3]!.includes('#2'))
  })

  it('不同 profile 不显示序号', () => {
    const w1 = worker({ workerId: 'w1', shortLabel: 'W1', profile: 'code_scout', activity: undefined })
    const w2 = worker({ workerId: 'w2', shortLabel: 'W2', profile: 'doc_scout', activity: undefined })
    const lines = buildWorkerFleetLines([w1, w2], undefined, 80)
    assert.ok(!lines[1]!.includes('#1'))
    assert.ok(!lines[2]!.includes('#1'))
  })

  it('多 worker 超 maxRows：折叠 …(+N)', () => {
    const workers = Array.from({ length: 9 }, (_, i) => worker({ workerId: `w${i}`, shortLabel: `T${i}` }))
    const lines = buildWorkerFleetLines(workers, { done: 0, total: 9, running: 9 }, 80, 6)
    // 新布局每 worker 2 行：头 + 6*2(主行+续行) + 折叠 + 提示 = 15
    assert.equal(lines.length, 15)
    assert.ok(lines[lines.length - 2]!.includes('(+3)'))
    assert.ok(lines[lines.length - 1]!.includes('/tasks'), '末行为管理提示')
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
  it('行数与 plain 一致（头 + worker 行 + 活动行 + 折叠）', () => {
    const workers = [worker(), worker({ workerId: 'w2', shortLabel: 'T2', status: 'passed' })]
    const colored = formatWorkerFleet(workers, theme, 80, { done: 1, total: 2, running: 1 })
    const plain = buildWorkerFleetLines(workers, { done: 1, total: 2, running: 1 }, 80)
    assert.equal(colored.length, plain.length)
  })

  it('溢出行也被着色', () => {
    const workers = Array.from({ length: 8 }, (_, i) => worker({ workerId: `w${i}`, shortLabel: `T${i}` }))
    const colored = formatWorkerFleet(workers, theme, 80, { done: 0, total: 8, running: 8 }, 6)
    // 新布局每 worker 2 行：头 + 6*2(主行+续行) + 折叠 + 提示 = 15
    assert.equal(colored.length, 15)
  })

  it('状态词列：passed 状态词在续行；无在跑时无提示行', () => {
    const lines = buildWorkerFleetLines(
      [worker({ status: 'passed' })],
      { done: 1, total: 2, running: 0 },
      80,
    )
    // 新布局：主行是身份，续行含状态词「完成」
    assert.ok(lines[2]!.includes('完成'), '续行应有状态词「完成」')
    assert.ok(!lines.some(l => l.includes('/tasks')), '无在跑 worker 时不渲染提示行')
  })

  it('completed + review-findings 渲染 warning 黄（审查拦截，非系统失败的 error 红）', () => {
    const reviewRow = formatWorkerRow(worker({ status: 'completed', failureReason: 'review-findings', activity: undefined }), theme, 80)
    const passRow = formatWorkerRow(worker({ status: 'completed', activity: undefined }), theme, 80)
    const failRow = formatWorkerRow(worker({ status: 'failed', activity: undefined }), theme, 80)
    // 三行内容同形（glyph/label/elapsed 相同），唯一差异是着色——据此区分三类
    assert.notEqual(reviewRow, failRow, '审查拦截 ≠ 系统失败红')
    assert.notEqual(reviewRow, passRow, '审查拦截 ≠ 普通完成绿（应是 warning 黄）')
    assert.notEqual(passRow, failRow, '普通完成绿 ≠ 系统失败红（ sanity ）')
  })

  it('completed 无 failureReason（普通完成）与 passed 同色（success 绿）', () => {
    const completedRow = formatWorkerRow(worker({ status: 'completed', activity: undefined }), theme, 80)
    const passedRow = formatWorkerRow(worker({ status: 'passed', activity: undefined }), theme, 80)
    assert.equal(completedRow, passedRow, '普通 completed 应与 passed 同为 success 绿')
  })
})

describe('worker-fleet task-first layout', () => {
  it('puts the objective on the branch (main) line', () => {
    const w = worker({ contract: contract({ objective: '定位 /tasks 舰队行渲染函数' }) })
    const txt = buildWorkerFleetLines([w], { done: 0, total: 1, running: 1 }, 80).join('\n')
    assert.match(txt, /定位 \/tasks 舰队行渲染函数/)
  })

  it('puts identity + counts + status on the continuation line', () => {
    const w = worker({ contract: contract(), toolUseCount: 5, tokenCount: 1200, authority: 'tianxuan' })
    const lines = buildWorkerFleetLines([w], { done: 0, total: 1, running: 1 }, 80)
    // second line (after header) is the branch, third line is the continuation
    const meta = lines[2]!
    assert.ok(meta, 'must have a continuation line')
    assert.match(meta, /天璇/, 'meta line shows star name')
    assert.match(meta, /5 工具/)
    assert.match(meta, /1\.2k tok/)
  })

  it('falls back to identity on the main line when there is no objective', () => {
    const w = worker({ authority: 'tianxuan' })  // no contract → no objective
    const txt = buildWorkerFleetLines([w], { done: 0, total: 1, running: 1 }, 80).join('\n')
    assert.match(txt, /侦察代码/, 'no objective → identity on main line')
  })

  it('never emits a line containing an embedded newline', () => {
    const w = worker({ contract: contract({ objective: 'line1\nline2' }) })
    const lines = buildWorkerFleetLines([w], { done: 0, total: 1, running: 1 }, 80)
    for (const l of lines) assert.equal(l.includes('\n'), false)
  })
})

describe('CJK objective 的宽度账（显示列而非字符数）', () => {
  it('50 字中文 objective 在 80 列预算内不折行', () => {
    const w = worker({ contract: contract({ objective: '审查认证模块的令牌刷新逻辑与并发安全边界并给出修复建议' }), elapsedMs: 90_000 })
    const lines = buildWorkerFleetLines([w], undefined, 80)
    for (const text of lines) {
      const plain = text.replace(/\x1B\[[0-9;]*m/g, '')
      assert.ok(displayWidth(plain, { ambiguousAsWide: true }) <= 80, `超宽：${plain}`)
    }
  })

  it('截断以 … 收尾且不劈代理对', () => {
    const w = worker({ contract: contract({ objective: '很长很长的任务目标带着表情 😀😀😀😀😀😀😀😀😀😀 继续继续继续继续继续' }), elapsedMs: 2000 })
    const lines = buildWorkerFleetLines([w], undefined, 40)
    const main = (lines.find(l => l.includes('└─') || l.includes('├─')) ?? '').replace(/\x1B\[[0-9;]*m/g, '')
    assert.ok(main.includes('…'), `截断应有省略号：${main}`)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(main), '不得留下孤立代理项')
    assert.ok(displayWidth(main, { ambiguousAsWide: true }) <= 40, `超宽：${main}`)
  })
})

/**
 * 紧凑档（live 区 chrome 段的子代理带）：对标 CC 的
 * `● general-purpose  {描述}  7m 44s · 68.6k tokens`——每 agent 恒 1 行。
 * 两行树把舰队规模按 2 倍放大成 live region 高度，而峰值会被定高视口的高水位
 * 固化成输入框上方的常驻空白。
 */
describe('buildWorkerFleetLines — compact（chrome 段子代理带）', () => {
  const three = [
    worker({ workerId: 'w1', contract: contract({ objective: '分析架构' }), toolUseCount: 2, tokenCount: 1200 }),
    worker({ workerId: 'w2', contract: contract({ objective: '修复类型' }), toolUseCount: 5, tokenCount: 3100 }),
    worker({ workerId: 'w3', contract: contract({ objective: '补测试' }), toolUseCount: 1, tokenCount: 400 }),
  ]

  it('每 worker 恒 1 行：3 个 worker = 头 + 3 行', () => {
    const lean = buildWorkerFleetLines(three, { done: 0, total: 3, running: 3 }, 80, 6, true)
    assert.equal(lean.length, 1 + 3, `应为汇总头 + 每 worker 1 行，实得 ${lean.length}: ${lean.join(' | ')}`)
    const full = buildWorkerFleetLines(three, { done: 0, total: 3, running: 3 }, 80, 6)
    assert.ok(full.length > lean.length, `完整档应更高: full=${full.length} lean=${lean.length}`)
  })

  it('身份与计数压进同一行，不再另起续行', () => {
    const lean = buildWorkerFleetLines([three[0]!], { done: 0, total: 1, running: 1 }, 80, 6, true)
    const row = lean[1]!
    assert.ok(row.includes('分析架构'), `目标在行内: ${row}`)
    assert.ok(row.includes('2 工具'), `工具计数在同一行: ${row}`)
    assert.ok(row.includes('tok'), `token 计数在同一行: ${row}`)
  })

  it('紧凑档不产出独立的 /tasks 提示行（入口由调用方并进汇总头）', () => {
    const lean = buildWorkerFleetLines(three, { done: 0, total: 3, running: 3 }, 80, 6, true)
    assert.ok(!lean.some(l => l.includes('管理面板')), `不应有独立提示行: ${lean.join(' | ')}`)
  })

  it('超过 maxRows 折叠成 …(+N)，总行数有硬顶', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      worker({ workerId: `w${i}`, contract: contract({ objective: `任务 ${i}` }) }))
    const lean = buildWorkerFleetLines(many, { done: 0, total: 9, running: 9 }, 80, 4, true)
    assert.ok(lean.some(l => l.includes('…(+5)')), `应折叠 5 个: ${lean.join(' | ')}`)
    assert.equal(lean.length, 1 + 4 + 1, `头 + 4 行 + 折叠行，实得 ${lean.length}`)
  })

  it('宽度账：紧凑行不超终端宽度（CJK 按显示列）', () => {
    const w = worker({ contract: contract({ objective: '审查认证模块的令牌刷新逻辑与并发安全边界并给出修复建议' }), elapsedMs: 90_000, toolUseCount: 12, tokenCount: 45_000 })
    for (const text of buildWorkerFleetLines([w], undefined, 80, 6, true)) {
      const plain = text.replace(/\x1B\[[0-9;]*m/g, '')
      assert.ok(displayWidth(plain, { ambiguousAsWide: true }) <= 80, `超宽：${plain}`)
    }
  })

  it('默认档（不传 compact）行为不变', () => {
    const a = buildWorkerFleetLines(three, { done: 0, total: 3, running: 3 }, 80, 6)
    const b = buildWorkerFleetLines(three, { done: 0, total: 3, running: 3 }, 80, 6, false)
    assert.deepEqual(a, b)
  })
})
