import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isCouncilEnabled } from '../council-gate.js'
import {
  buildCouncilSessionEvent,
  councilSessionKey,
  recordCouncilSession,
  type CouncilTelemetryStore,
} from '../council-telemetry.js'
import type { CouncilPlan } from '../council-plan.js'

describe('isCouncilEnabled — kill switch', () => {
  const saved = process.env.COUNCIL
  afterEach(() => {
    if (saved === undefined) delete process.env.COUNCIL
    else process.env.COUNCIL = saved
  })

  it('缺省 → 开启', () => {
    delete process.env.COUNCIL
    assert.equal(isCouncilEnabled(), true)
  })
  it('COUNCIL=0 → 关闭', () => {
    process.env.COUNCIL = '0'
    assert.equal(isCouncilEnabled(), false)
  })
  it('COUNCIL=false → 关闭', () => {
    process.env.COUNCIL = 'false'
    assert.equal(isCouncilEnabled(), false)
  })
  it('COUNCIL=1 → 开启', () => {
    process.env.COUNCIL = '1'
    assert.equal(isCouncilEnabled(), true)
  })
})

function fakePlan(objective: string, hash: string, convenedAt: number): CouncilPlan {
  return {
    objective,
    seats: ['tianquan', 'tianfu'],
    contributions: [],
    aggregate: {
      decisions: [
        { id: 'a:addition:0', source: 'a', kind: 'addition', title: 't', rationale: 'r', verdict: 'accepted' },
        { id: 'a:alternative:0', source: 'a', kind: 'alternative', title: 't', rationale: 'r', verdict: 'rejected' },
      ],
      mergedItems: [{ id: 'T1', title: 't', detail: 'd' }],
      conflicts: [{ description: 'c', left: 'l', right: 'r', key: 'k', status: 'open' as const }],
    },
    finalPlanMarkdown: '',
    meta: { round: 1, convenedAt, objectiveHash: hash },
  }
}

describe('council telemetry — append-only', () => {
  let store: CouncilTelemetryStore & { rows: Map<string, string> }
  beforeEach(() => {
    const rows = new Map<string, string>()
    // 模拟 saveBanditState 的 ON CONFLICT(kind) UPSERT 语义。
    store = { rows, saveBanditState: (kind, json) => { rows.set(kind, json) } }
  })

  it('同 objective 两次会诊 → 两条记录不互相覆盖（key 含 timestamp）', () => {
    const e1 = buildCouncilSessionEvent({ sessionId: 's1', plan: fakePlan('split', 'h1', 10), timestamp: 100 })
    const e2 = buildCouncilSessionEvent({ sessionId: 's1', plan: fakePlan('split', 'h1', 20), timestamp: 200 })
    recordCouncilSession(store, e1)
    recordCouncilSession(store, e2)
    assert.equal(store.rows.size, 2, '两次会诊应各留一条 append-only 记录')
  })

  it('反证：若 key 不含 timestamp，第二次会覆盖第一次', () => {
    // 故意用不含 timestamp 的 key 模拟「虚假 append-only」。
    const collidingKey = (e: { sessionId: string; objectiveHash: string }) => `council_session:${e.sessionId}:${e.objectiveHash}`
    const e1 = buildCouncilSessionEvent({ sessionId: 's1', plan: fakePlan('split', 'h1', 10), timestamp: 100 })
    const e2 = buildCouncilSessionEvent({ sessionId: 's1', plan: fakePlan('split', 'h1', 20), timestamp: 200 })
    store.saveBanditState(collidingKey(e1), JSON.stringify(e1))
    store.saveBanditState(collidingKey(e2), JSON.stringify(e2))
    assert.equal(store.rows.size, 1, '无 timestamp 的 key 会退化为覆盖 —— 正是真实 key 要规避的')
  })

  it('事件体统计正确：accepted/rejected/conflict/mergedItem/roundsRun', () => {
    const e = buildCouncilSessionEvent({ sessionId: 's1', plan: fakePlan('split', 'h1', 10), timestamp: 100 })
    assert.equal(e.decisionCount, 2)
    assert.equal(e.acceptedCount, 1)
    assert.equal(e.rejectedCount, 1)
    assert.equal(e.conflictCount, 1)
    assert.equal(e.mergedItemCount, 1)
    assert.equal(e.roundsRun, 1)
    assert.match(councilSessionKey(e), /^council_session:s1:h1:100$/)
  })

  it('roundsRun 反映多轮 plan.meta.round', () => {
    const multi: CouncilPlan = { ...fakePlan('split', 'h1', 10), meta: { round: 2, convenedAt: 10, objectiveHash: 'h1' } }
    const e = buildCouncilSessionEvent({ sessionId: 's1', plan: multi, timestamp: 100 })
    assert.equal(e.roundsRun, 2)
  })

  it('store 抛错被吞，不影响调用方；undefined store 安全', () => {
    const throwing: CouncilTelemetryStore = { saveBanditState: () => { throw new Error('db down') } }
    const e = buildCouncilSessionEvent({ sessionId: 's1', plan: fakePlan('split', 'h1', 10), timestamp: 100 })
    assert.doesNotThrow(() => recordCouncilSession(throwing, e))
    assert.doesNotThrow(() => recordCouncilSession(undefined, e))
  })
})
