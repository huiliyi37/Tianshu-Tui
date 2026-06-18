import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderCouncilPlan } from '../council-render.js'
import { aggregateCouncil } from '../council-plan.js'
import type { CouncilPlan, CouncilDraft, SeatContribution } from '../council-plan.js'

const draft: CouncilDraft = { objective: 'mission X', items: [{ id: 'T1', title: 'Task1', detail: 'd1' }] }
const contributions: SeatContribution[] = [
  { authority: 'tianquan', summary: '权衡完成', additions: [{ id: 'A1', title: 'addA', detail: 'detailA' }], risks: [], challenges: ['前提成立吗?'], alternatives: [{ proposal: '事件溯源', recommend: false, rationale: '成本过高' }] },
  { authority: 'tianfu', summary: '风险审完', additions: [], risks: [{ claim: '缺回滚', severity: 'high', mitigation: '加 rollback', itemId: 'T1' }], challenges: [], alternatives: [] },
]
function makePlan(): CouncilPlan {
  const aggregate = aggregateCouncil(draft, contributions)
  return { objective: draft.objective, seats: ['tianquan', 'tianfu'], contributions, aggregate, finalPlanMarkdown: '', meta: { round: 1, convenedAt: 1234, objectiveHash: 'h' } }
}

describe('renderCouncilPlan', () => {
  it('含全部席位', () => {
    const md = renderCouncilPlan(makePlan())
    assert.match(md, /### tianquan/)
    assert.match(md, /### tianfu/)
  })
  it('含三类裁决分组', () => {
    const md = renderCouncilPlan(makePlan())
    assert.match(md, /### 接受/); assert.match(md, /### 拒绝/); assert.match(md, /### 暂缓/)
  })
  it('rejected 项带理由', () => {
    const md = renderCouncilPlan(makePlan())
    assert.match(md, /成本过高/)
  })
  it('最终任务表含合并条目', () => {
    const md = renderCouncilPlan(makePlan())
    assert.match(md, /\| A1 \| addA \| detailA \|/)
    assert.match(md, /\| T1 \| Task1 \| d1 \|/)
  })
  it('确定性：两次渲染字节相等', () => {
    assert.equal(renderCouncilPlan(makePlan()), renderCouncilPlan(makePlan()))
  })
})
