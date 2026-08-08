/**
 * 议事会终态 verdict 卡（scrollback）。
 *
 * 契约：每席恒 1 行；verdict 四项恒在；sealVersion / failedSeats 有才出行；
 * 行宽按 display-width 计（CJK 域名与省略号都按 2 列算，超宽会在终端折行 →
 * rowsForLine 少算 → 旧帧残留被顶进 scrollback）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCouncilPanelLines, formatCouncilPanel } from '../council-panel.js'
import type { CouncilPanelModel } from '../../council-panel-model.js'
import { getTheme } from '../../theme.js'
import { displayWidth } from '../../width.js'

const theme = getTheme(0)
const WIDE = { ambiguousAsWide: true }
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')

function model(over: Partial<CouncilPanelModel> = {}): CouncilPanelModel {
  return {
    schemaVersion: 1,
    objective: '评审认证模块重构方案',
    seats: [
      { authority: 'tianquan', status: 'passed', round: 1, modelUsed: 'deepseek-v4' },
      { authority: 'tianji', status: 'failed', round: 2 },
    ],
    verdict: { accepted: 3, rejected: 1, deferred: 0, conflicts: 2 },
    pillarsMode: false,
    ...over,
  }
}

describe('formatCouncilPanel', () => {
  it('头行给席位数与目标，每席恒 1 行', () => {
    const lines = buildCouncilPanelLines(model(), 80)
    assert.ok(lines[0]!.includes('议事会'), `头行: ${lines[0]}`)
    assert.ok(lines[0]!.includes('2 席'), '席位数')
    assert.ok(lines[0]!.includes('评审认证模块重构方案'), '目标')
    // 头 + 2 席 + verdict = 4 行（无 seal / failedSeats）
    assert.equal(lines.length, 4, `应为 4 行，实得 ${lines.length}: ${lines.join(' | ')}`)
    for (const l of lines) assert.equal(l.includes('\n'), false, '单行内不得含换行')
  })

  it('席位行带 round 与 modelUsed', () => {
    const lines = buildCouncilPanelLines(model(), 80)
    const seatLine = lines.find(l => l.includes('r1'))!
    assert.ok(seatLine, 'round 1 席位行在')
    assert.ok(seatLine.includes('deepseek-v4'), `modelUsed 在行内: ${seatLine}`)
    assert.ok(lines.some(l => l.includes('r2')), 'round 2 席位行在')
  })

  it('verdict 四项恒在', () => {
    const plain = buildCouncilPanelLines(model(), 80).join('\n')
    assert.ok(plain.includes('3 通过'), '通过数')
    assert.ok(plain.includes('1 驳回'), '驳回数')
    assert.ok(plain.includes('0 待议'), '待议数（零也要显示）')
    assert.ok(plain.includes('2 冲突'), '冲突数')
  })

  it('sealVersion 与 failedSeats 有才出行', () => {
    const bare = buildCouncilPanelLines(model(), 80).join('\n')
    assert.ok(!bare.includes('密封'), '无 sealVersion 时不出密封行')
    assert.ok(!bare.includes('失败席'), '无 failedSeats 时不出失败席行')

    const rich = buildCouncilPanelLines(model({ sealVersion: 7, failedSeats: ['tianji'] }), 80).join('\n')
    assert.ok(rich.includes('密封 v7'), '密封版本')
    assert.ok(rich.includes('失败席'), '失败席行')
  })

  it('sealVersion 为 0 时仍渲染（0 是合法版本，不能被假值吞掉）', () => {
    const plain = buildCouncilPanelLines(model({ sealVersion: 0 }), 80).join('\n')
    assert.ok(plain.includes('密封 v0'), `v0 应渲染: ${plain}`)
  })

  it('宽度账：长目标与长域名都不超终端宽度（CJK 按显示列）', () => {
    const wide = model({
      objective: '评审认证模块的令牌刷新逻辑与并发安全边界并给出完整的修复建议清单以及回归验证方案',
      seats: [
        { authority: 'tianquan', status: 'passed', round: 1, modelUsed: 'deepseek-v4-very-long-model-name' },
        { authority: 'a'.repeat(60), status: 'running', round: 1 },
      ],
      failedSeats: ['x'.repeat(80)],
      sealVersion: 3,
    })
    for (const cols of [48, 60, 80, 120]) {
      for (const text of buildCouncilPanelLines(wide, cols)) {
        // rule 上限 76，故按 min(cols, 76) 校验
        const limit = Math.min(Math.max(48, cols), 76)
        assert.ok(
          displayWidth(text, WIDE) <= limit,
          `cols=${cols} 超宽 ${displayWidth(text, WIDE)}>${limit}: ${text}`,
        )
      }
    }
  })

  it('带色渲染与纯文本行数一致，剥色后内容相同', () => {
    const m = model({ sealVersion: 1, failedSeats: ['tianji'] })
    const plain = buildCouncilPanelLines(m, 80)
    const colored = formatCouncilPanel(m, theme, 80)
    assert.equal(colored.length, plain.length)
    assert.deepEqual(colored.map(stripAnsi), plain)
  })

  it('空席位列表不崩，仍给头与 verdict', () => {
    const lines = buildCouncilPanelLines(model({ seats: [] }), 80)
    assert.ok(lines[0]!.includes('0 席'))
    assert.ok(lines.join('\n').includes('通过'))
  })
})
