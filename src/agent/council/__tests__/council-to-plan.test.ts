import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { councilPlanToUnifiedPlan } from '../council-to-plan.js'
import { validateUnifiedPlan } from '../../unified-plan.js'
import type { CouncilPlan, CouncilAggregate, SeatContribution } from '../council-plan.js'

function agg(over: Partial<CouncilAggregate> = {}): CouncilAggregate {
  return { decisions: [], conflicts: [], mergedItems: [{ id: 'T1', title: 'Task1', detail: 'do T1', files: ['src/loop.ts'] }], ...over }
}
function plan(over: Partial<CouncilPlan> = {}): CouncilPlan {
  return {
    objective: 'split loop.ts',
    seats: ['tianquan', 'tianfu'],
    contributions: [],
    aggregate: agg(),
    finalPlanMarkdown: '',
    meta: { round: 1, convenedAt: 1234, objectiveHash: 'h' },
    ...over,
  }
}
function seat(over: Partial<SeatContribution> & { authority: string }): SeatContribution {
  return { summary: '', additions: [], risks: [], challenges: [], alternatives: [], ...over }
}

describe('councilPlanToUnifiedPlan', () => {
  it('mergedItem → patch_proposal 节点，字段映射 + files 透传', () => {
    const u = councilPlanToUnifiedPlan(plan())
    assert.equal(u.version, 1)
    assert.equal(u.objective, 'split loop.ts')
    assert.equal(u.source, 'manual')
    assert.equal(u.createdAt, 1234)
    assert.equal(u.tasks.length, 1)
    const t = u.tasks[0]!
    assert.equal(t.id, 'T1')
    assert.equal(t.title, 'Task1')
    assert.equal(t.objective, 'do T1')
    assert.equal(t.kind, 'patch_proposal')
    assert.equal(t.profile, 'patcher')
    assert.deepEqual(t.files, ['src/loop.ts'])
    assert.deepEqual(t.dependsOn, [])
  })

  it('产物通过 validateUnifiedPlan', () => {
    const v = validateUnifiedPlan(councilPlanToUnifiedPlan(plan()))
    assert.equal(v.valid, true, JSON.stringify(v))
  })

  it('objective 取 detail；detail 空时回退 title', () => {
    const u = councilPlanToUnifiedPlan(plan({ aggregate: agg({ mergedItems: [{ id: 'T1', title: 'OnlyTitle', detail: '' }] }) }))
    assert.equal(u.tasks[0]!.objective, 'OnlyTitle')
  })

  it('riskTier：按 itemId 聚合最高 severity，无关联默认 medium', () => {
    const p = plan({
      aggregate: agg({ mergedItems: [{ id: 'T1', title: 't', detail: 'd' }, { id: 'T2', title: 't2', detail: 'd2' }] }),
      contributions: [seat({ authority: 'a', risks: [
        { claim: 'r1', severity: 'low', mitigation: 'm', itemId: 'T1' },
        { claim: 'r2', severity: 'high', mitigation: 'm', itemId: 'T1' },
      ] })],
    })
    const u = councilPlanToUnifiedPlan(p)
    assert.equal(u.tasks.find(t => t.id === 'T1')!.riskTier, 'high')
    assert.equal(u.tasks.find(t => t.id === 'T2')!.riskTier, 'medium')
  })

  it('泛化风险（无 itemId）不参与聚合', () => {
    const p = plan({ contributions: [seat({ authority: 'a', risks: [{ claim: 'x', severity: 'high', mitigation: 'm' }] })] })
    assert.equal(councilPlanToUnifiedPlan(p).tasks[0]!.riskTier, 'medium')
  })

  it('缺省 files → 空数组', () => {
    const u = councilPlanToUnifiedPlan(plan({ aggregate: agg({ mergedItems: [{ id: 'T1', title: 't', detail: 'd' }] }) }))
    assert.deepEqual(u.tasks[0]!.files, [])
  })

  it('rejected 决议 → nonGoals', () => {
    const p = plan({ aggregate: agg({
      decisions: [{ id: 'a:alternative:0', source: 'a', kind: 'alternative', title: '事件溯源', rationale: '成本高', verdict: 'rejected' }],
    }) })
    assert.deepEqual(councilPlanToUnifiedPlan(p).nonGoals, ['事件溯源'])
  })

  it('无 rejected → 不带 nonGoals 字段', () => {
    assert.equal(councilPlanToUnifiedPlan(plan()).nonGoals, undefined)
  })

  it('确定性：两次转换字节相等', () => {
    assert.equal(JSON.stringify(councilPlanToUnifiedPlan(plan())), JSON.stringify(councilPlanToUnifiedPlan(plan())))
  })

  it('空 mergedItems → tasks 空（交给 convene 层判空不产 planJson）', () => {
    const u = councilPlanToUnifiedPlan(plan({ aggregate: agg({ mergedItems: [] }) }))
    assert.equal(u.tasks.length, 0)
  })
})
