import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateCouncil } from '../council-plan.js'
import type { CouncilDraft, SeatContribution } from '../council-plan.js'

const draft: CouncilDraft = {
  objective: 'refactor the loop',
  items: [{ id: 'T1', title: 'Task 1', detail: 'do T1' }],
}
function seat(over: Partial<SeatContribution> & { authority: string }): SeatContribution {
  return { summary: '', additions: [], risks: [], challenges: [], alternatives: [], ...over }
}

describe('aggregateCouncil — 留痕不丢', () => {
  it('每条贡献恰好产生一条 decision', () => {
    const c = seat({ authority: 'tianquan',
      additions: [{ id: 'A1', title: 'a', detail: 'd' }],
      risks: [{ claim: 'r', severity: 'low', mitigation: 'm' }],
      challenges: ['why?'],
      alternatives: [{ proposal: 'alt', recommend: false, rationale: 'because' }] })
    const agg = aggregateCouncil(draft, [c])
    assert.equal(agg.decisions.length, 4)
  })
})

describe('aggregateCouncil — 空 id 不得 match-all（瑶光族①）', () => {
  it('空白 id 的 addition 被 rejected，不进 mergedItems', () => {
    const c = seat({ authority: 'tianfu', additions: [{ id: '   ', title: 'ghost', detail: 'x' }] })
    const agg = aggregateCouncil(draft, [c])
    const d = agg.decisions.find(x => x.kind === 'addition')!
    assert.equal(d.verdict, 'rejected')
    assert.equal(agg.mergedItems.length, 1) // 仅原 T1，幽灵未混入
  })
})

describe('aggregateCouncil — 去重 vs 冲突', () => {
  it('同 id 同 detail = duplicate(deferred)，不计冲突、不重复加入', () => {
    const c = seat({ authority: 'tianji', additions: [{ id: 'T1', title: 'dup', detail: 'do T1' }] })
    const agg = aggregateCouncil(draft, [c])
    assert.equal(agg.mergedItems.length, 1)
    assert.equal(agg.conflicts.length, 0)
    assert.equal(agg.decisions.find(d => d.kind === 'addition')!.verdict, 'deferred')
  })
  it('同 id 不同 detail = 冲突 + deferred', () => {
    const c = seat({ authority: 'tianji', additions: [{ id: 'T1', title: 'x', detail: 'DIFFERENT' }] })
    const agg = aggregateCouncil(draft, [c])
    assert.equal(agg.conflicts.length, 1)
    assert.equal(agg.decisions.find(d => d.kind === 'addition')!.conflictWith, 'T1')
  })
})

describe('aggregateCouncil — 冲突无序去重（瑶光族②）', () => {
  it('(A,B) 与 (B,A) 只登记一次', () => {
    const a = seat({ authority: 's1', additions: [{ id: 'NEW', title: 'a', detail: 'X' }] })
    const b = seat({ authority: 's2', additions: [{ id: 'NEW', title: 'b', detail: 'Y' }] })
    const c = seat({ authority: 's3', additions: [{ id: 'NEW', title: 'c', detail: 'X' }] })
    const agg = aggregateCouncil(draft, [a, b, c])
    assert.equal(agg.conflicts.length, 1)
  })
})

describe('aggregateCouncil — risk×alternative 仅具体 itemId', () => {
  it('泛化风险(无 itemId)不与备选 match-all', () => {
    const a = seat({ authority: 'tianfu', risks: [{ claim: 'broad', severity: 'high', mitigation: 'm' }] })
    const b = seat({ authority: 'tianxuan', alternatives: [{ proposal: 'p', recommend: true, rationale: 'r', targetItemId: 'T1' }] })
    const agg = aggregateCouncil(draft, [a, b])
    assert.equal(agg.conflicts.length, 0)
  })
  it('具体 itemId 的 high risk 撞 accept 备选 → 冲突', () => {
    const a = seat({ authority: 'tianfu', risks: [{ claim: 'risky', severity: 'high', mitigation: 'm', itemId: 'T1' }] })
    const b = seat({ authority: 'tianxuan', alternatives: [{ proposal: 'p', recommend: true, rationale: 'r', targetItemId: 'T1' }] })
    const agg = aggregateCouncil(draft, [a, b])
    assert.equal(agg.conflicts.length, 1)
    assert.equal(agg.decisions.find(d => d.kind === 'risk')!.conflictWith, 'tianxuan:alt:T1')
  })
})

describe('aggregateCouncil — rejected 必带理由 / deferred≠删除', () => {
  it('rejected 备选保留非空 rationale', () => {
    const c = seat({ authority: 's', alternatives: [{ proposal: 'p', recommend: false, rationale: 'too costly' }] })
    const d = aggregateCouncil(draft, [c]).decisions.find(x => x.kind === 'alternative')!
    assert.equal(d.verdict, 'rejected')
    assert.ok(d.rationale.length > 0)
  })
  it('challenge 以 deferred 留在 ledger', () => {
    const c = seat({ authority: 's', challenges: ['edge case?'] })
    const d = aggregateCouncil(draft, [c]).decisions.find(x => x.kind === 'challenge')!
    assert.equal(d.verdict, 'deferred')
  })
})

describe('aggregateCouncil — 确定性', () => {
  it('同输入两次调用结果深相等（无 Date/随机）', () => {
    const c = seat({ authority: 's', additions: [{ id: 'A', title: 't', detail: 'd' }], risks: [{ claim: 'r', severity: 'low', mitigation: 'm' }] })
    assert.deepEqual(aggregateCouncil(draft, [c]), aggregateCouncil(draft, [c]))
  })
})
