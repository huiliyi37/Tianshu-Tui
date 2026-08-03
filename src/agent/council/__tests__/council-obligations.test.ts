import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractObligations, attachObligations, verifyObligations, formatObligationReport,
  type ObligationEntry, type PlanWithObligations,
} from '../council-obligations.js'
import type { CouncilPlan, SeatContribution } from '../council-plan.js'
import { serializeUnifiedPlan, deserializeUnifiedPlan, type UnifiedPlan } from '../../unified-plan.js'

function contribution(authority: string, overrides?: Partial<SeatContribution>): SeatContribution {
  return { authority, summary: 's', additions: [], risks: [], challenges: [], alternatives: [], ...overrides }
}

function councilPlan(overrides?: Partial<CouncilPlan>): CouncilPlan {
  return {
    objective: 'x',
    seats: ['tianquan'],
    contributions: [],
    aggregate: { decisions: [], mergedItems: [], conflicts: [] },
    finalPlanMarkdown: '',
    meta: { round: 1, convenedAt: 1, objectiveHash: 'h' },
    ...overrides,
  }
}

describe('extractObligations — Norns 义务提取', () => {
  it('deferred 裁决 + 高危缓解承诺 + advisory gate 入账；blocking gate 不入账（走编译门）', () => {
    const plan = councilPlan({
      contributions: [
        contribution('tianquan', {
          risks: [
            { claim: '缓存碎裂', severity: 'high', mitigation: '加字节稳定测试' },
            { claim: '小风险', severity: 'low', mitigation: '无所谓' },
          ],
          challenges: [
            { text: '类型必须过', severity: 'advisory', gate: 'npx tsc --noEmit' },
            { text: '否决级', severity: 'blocking', gate: 'npm test' },
          ],
        }),
      ],
      aggregate: {
        decisions: [
          { id: 'a:alternative:0', source: 'tianfu', kind: 'alternative', title: '备选方案B', rationale: '待议', verdict: 'deferred' },
          { id: 'a:addition:0', source: 'tianfu', kind: 'addition', title: 'ok', rationale: 'r', verdict: 'accepted' },
        ],
        mergedItems: [], conflicts: [],
      },
    })
    const entries = extractObligations(plan)
    assert.deepEqual(entries.map(e => e.kind), ['deferred_decision', 'high_risk_mitigation', 'advisory_gate'])
    assert.match(entries[0]!.text, /备选方案B/)
    assert.match(entries[1]!.text, /加字节稳定测试/)
    assert.equal(entries[2]!.gate, 'npx tsc --noEmit')
  })

  it('r2 贡献不重复入账；零义务返回空数组', () => {
    const plan = councilPlan({
      contributions: [
        contribution('tianquan', { round: 2, challenges: [{ text: 'r2', severity: 'advisory', gate: 'npm test' }] }),
      ],
    })
    assert.deepEqual(extractObligations(plan), [])
  })

  it('high risk 缺 mitigation 字段（LLM 输出不可信）不崩溃且不入账', () => {
    const plan = councilPlan({
      contributions: [
        contribution('tianquan', {
          // LLM 输出可能缺 mitigation —— 类型断言模拟运行时非法输入
          risks: [{ claim: '缓存碎裂', severity: 'high' }] as unknown as SeatContribution['risks'],
        }),
      ],
    })
    assert.deepEqual(extractObligations(plan), [])
  })
})

describe('attachObligations — 契约挂载与 JSON 透传', () => {
  const basePlan: UnifiedPlan = {
    version: 1, objective: 'x', source: 'manual', createdAt: 1,
    tasks: [{ id: 'T1', title: 't', objective: 'o', profile: 'implementer', kind: 'patch_proposal', files: [], dependsOn: [], riskTier: 'low' }],
  }

  it('零义务不挂字段（字节稳定）；有义务经序列化往返存活', () => {
    assert.equal((attachObligations(basePlan, []) as PlanWithObligations).obligations, undefined)
    const entries: ObligationEntry[] = [{ id: 'advisory_gate:0', kind: 'advisory_gate', text: 't', source: 'tianquan', gate: 'npm test' }]
    const withLedger = attachObligations(basePlan, entries)
    const roundTripped = deserializeUnifiedPlan(serializeUnifiedPlan(withLedger)) as PlanWithObligations
    assert.deepEqual(roundTripped.obligations, entries)
  })
})

describe('verifyObligations + formatObligationReport — 交付前核验', () => {
  const entries: ObligationEntry[] = [
    { id: 'advisory_gate:0', kind: 'advisory_gate', text: '类型必须过', source: 'tianquan', gate: 'npx tsc --noEmit' },
    { id: 'advisory_gate:1', kind: 'advisory_gate', text: '人工冒烟', source: 'huagai', gate: '打开桌面端点三下' },
    { id: 'deferred_decision:2', kind: 'deferred_decision', text: '暂缓项待裁', source: 'tianfu' },
  ]

  it('白名单 gate 真实执行判 settled/unsettled；非白名单与暂缓项 → manual', () => {
    const ran: string[] = []
    const results = verifyObligations(entries, cmd => { ran.push(cmd); return { ok: false, detail: '3 failed' } })
    assert.deepEqual(ran, ['npx tsc --noEmit'], '只执行白名单形状命令')
    assert.deepEqual(results.map(r => r.status), ['unsettled', 'manual', 'manual'])
  })

  it('报告：unsettled 强警告，manual 要求逐项披露；空账零输出', () => {
    const results = verifyObligations(entries, () => ({ ok: false, detail: 'x' }))
    const report = formatObligationReport(results).join('\n')
    assert.match(report, /议事会义务账核验/)
    assert.match(report, /验收 gate 未通过/)
    assert.match(report, /逐项披露/)
    assert.deepEqual(formatObligationReport([]), [])
  })

  it('gate 全过 → 全 settled 无警告', () => {
    const gateOnly = entries.slice(0, 1)
    const results = verifyObligations(gateOnly, () => ({ ok: true }))
    assert.equal(results[0]!.status, 'settled')
    const report = formatObligationReport(results).join('\n')
    assert.match(report, /1\/1 已清偿/)
    assert.doesNotMatch(report, /未通过/)
  })
})
