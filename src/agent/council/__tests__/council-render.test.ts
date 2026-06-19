import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderCouncilPlan, summarizeCouncilPlan } from '../council-render.js'
import { aggregateCouncil } from '../council-plan.js'
import type { CouncilPlan, CouncilDraft, SeatContribution } from '../council-plan.js'

const draft: CouncilDraft = { objective: 'mission X', items: [{ id: 'T1', title: 'Task1', detail: 'd1' }] }
const contributions: SeatContribution[] = [
  { authority: 'tianquan', summary: '权衡完成', additions: [{ id: 'A1', title: 'addA', detail: 'detailA' }], risks: [], challenges: ['前提成立吗?'], alternatives: [{ proposal: '事件溯源', recommend: false, rationale: '成本过高' }], modelUsed: 'deepseek-v4' },
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
  it('渲染模型信息（modelUsed）', () => {
    const md = renderCouncilPlan(makePlan())
    // 天权有 modelUsed → 含模型标注
    assert.match(md, /模型: deepseek-v4/)
    // 天府无 modelUsed → 不含
    assert.ok(!md.includes('模型: undefined'))
  })
  it('确定性：两次渲染字节相等', () => {
    assert.equal(renderCouncilPlan(makePlan()), renderCouncilPlan(makePlan()))
  })
  it('单轮渲染「1 轮会诊」', () => {
    assert.match(renderCouncilPlan(makePlan()), /1 轮会诊/)
  })
})

describe('renderCouncilPlan — 多轮', () => {
  it('meta.round=2 渲染「2 轮会诊」且冲突表含化解状态', () => {
    const plan: CouncilPlan = {
      objective: 'o', seats: ['s1', 's2'], contributions: [],
      aggregate: {
        decisions: [], mergedItems: [],
        conflicts: [{ description: 'd', left: 'L', right: 'R', key: 'k', status: 'resolved', resolution: '让步收敛' }],
      },
      finalPlanMarkdown: '', meta: { round: 2, convenedAt: 1, objectiveHash: 'h' },
    }
    const md = renderCouncilPlan(plan)
    assert.match(md, /2 轮会诊/)
    assert.match(md, /已化解/)
    assert.match(md, /让步收敛/)
  })

  function multiRoundPlan(): CouncilPlan {
    return {
      objective: 'o', seats: ['tianquan', 'tianfu'],
      contributions: [
        { authority: 'tianquan', summary: 'r1权摘要', additions: [], risks: [], challenges: [], alternatives: [] },
        { authority: 'tianfu', summary: 'r1府摘要', additions: [], risks: [], challenges: [], alternatives: [] },
        { authority: 'tianquan', summary: 'r2权摘要', additions: [], risks: [], challenges: [], alternatives: [], round: 2, rebuttals: [{ conflictKey: 'k', stance: 'hold', argument: '坚持拆分粒度' }] },
        { authority: 'tianfu', summary: 'r2府摘要', additions: [], risks: [], challenges: [], alternatives: [], round: 2, rebuttals: [{ conflictKey: 'k', stance: 'concede', argument: '认同方向' }] },
      ],
      aggregate: {
        decisions: [], mergedItems: [],
        conflicts: [{ description: '拆分粒度分歧', left: 'L', right: 'R', key: 'k', status: 'resolved', resolution: '认同方向' }],
      },
      finalPlanMarkdown: '', meta: { round: 2, convenedAt: 1, objectiveHash: 'h' },
    }
  }

  it('渲染第二轮反驳段：各席 stance + argument 可见', () => {
    const md = renderCouncilPlan(multiRoundPlan())
    assert.match(md, /第二轮反驳/)
    assert.match(md, /让步/)           // concede 中文
    assert.match(md, /坚持/)           // hold 中文
    assert.match(md, /认同方向/)       // tianfu argument
    assert.match(md, /坚持拆分粒度/)   // tianquan argument
    assert.match(md, /拆分粒度分歧/)   // conflictKey 映射回冲突描述
  })

  it('round2 贡献不重复进席位贡献段（每席只出现一次，r2 摘要不外泄）', () => {
    const md = renderCouncilPlan(multiRoundPlan())
    assert.equal((md.match(/### tianquan/g) ?? []).length, 1, '天权只应在席位贡献段出现一次')
    assert.equal((md.match(/### tianfu/g) ?? []).length, 1, '天府只应在席位贡献段出现一次')
    assert.ok(!md.includes('r2权摘要') && !md.includes('r2府摘要'), 'round2 摘要不应被当作席位贡献渲染')
  })
})

describe('summarizeCouncilPlan', () => {
  it('紧凑摘要含席位数/objective/裁决计数/任务数,且 ≤4 行(工具卡阈值)', () => {
    const summary = summarizeCouncilPlan(makePlan())
    const linesCount = summary.split('\n').length
    assert.ok(linesCount <= 4, `摘要 ${linesCount} 行超过工具卡 4 行预览阈值`)
    assert.match(summary, /2 席 1 轮/)
    assert.match(summary, /mission X/)
    assert.match(summary, /接受 \d+ · 拒绝 \d+ · 暂缓 \d+/)
    assert.match(summary, /最终任务 \d+ 项/)
  })
  it('确定性：两次摘要字节相等', () => {
    assert.equal(summarizeCouncilPlan(makePlan()), summarizeCouncilPlan(makePlan()))
  })
})
