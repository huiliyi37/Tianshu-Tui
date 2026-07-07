import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  routeCouncilSeat,
  buildCouncilRoutingShadow,
  councilRoutingShadowKind,
  persistCouncilRoutingShadow,
  type CouncilRoutingShadowStore,
} from '../council-routing.js'

describe('routeCouncilSeat — authority 升级 + 瑶光门', () => {
  it('天府高风险席 → strong（authority 升级路径，council_expert 无 tierLock）', () => {
    const r = routeCouncilSeat({ authority: 'tianfu' }, { riskTier: 'high' })
    assert.equal(r.tier, 'strong')
    assert.equal(r.recommendedTier, 'strong')
    assert.equal(r.hardFloor, 'strong')
    assert.equal(r.gated, false)
  })

  it('天璇规划席 → balanced', () => {
    const r = routeCouncilSeat({ authority: 'tianxuan' })
    assert.equal(r.tier, 'balanced')
  })

  it('未知权能席默认 → cheap', () => {
    const r = routeCouncilSeat({ authority: 'tianji' })
    assert.equal(r.tier, 'cheap')
    assert.equal(r.hardFloor, undefined)
  })

  it('瑶光门：noDowngrade + tierHint:strong 把弱推荐席抬到 strong', () => {
    const r = routeCouncilSeat({ authority: 'tianji', tierHint: 'strong', noDowngrade: true })
    assert.equal(r.tier, 'strong')
    assert.equal(r.recommendedTier, 'cheap')
    assert.equal(r.gated, true)
  })

  it('反证：去掉 noDowngrade → tierHint 仅记录，tier 回落推荐 cheap', () => {
    const r = routeCouncilSeat({ authority: 'tianji', tierHint: 'strong', noDowngrade: false })
    assert.equal(r.tier, 'cheap')
    assert.equal(r.gated, false)
  })

  it('瑶光门只抬升不降级：noDowngrade + tierHint:cheap 不会把天府高风险席压低', () => {
    const r = routeCouncilSeat({ authority: 'tianfu', tierHint: 'cheap', noDowngrade: true }, { riskTier: 'high' })
    assert.equal(r.tier, 'strong', 'cheap hint 不得击穿 policy strong 硬地板')
  })
})

describe('council routing shadow — append-only', () => {
  it('key 含 seat+timestamp，两席/两次不互相覆盖', () => {
    const base = { sessionId: 's1', objectiveHash: 'h1', timestamp: 100 }
    const a = councilRoutingShadowKind({ ...base, seat: 'tianfu' })
    const b = councilRoutingShadowKind({ ...base, seat: 'tianxuan' })
    const c = councilRoutingShadowKind({ ...base, seat: 'tianfu', timestamp: 200 })
    assert.notEqual(a, b)
    assert.notEqual(a, c)
    assert.match(a, /^council_routing_shadow:s1:h1:tianfu:100$/)
  })

  it('buildCouncilRoutingShadow 映射 route → 事件体', () => {
    const route = routeCouncilSeat({ authority: 'tianfu' }, { riskTier: 'high' })
    const ev = buildCouncilRoutingShadow({ sessionId: 's1', objectiveHash: 'h1', route, timestamp: 5 })
    assert.equal(ev.seat, 'tianfu')
    assert.equal(ev.finalTier, 'strong')
    assert.equal(ev.recommendedTier, 'strong')
    assert.equal(ev.timestamp, 5)
  })

  it('persist 落盘到 store；store 抛错被吞，不影响调用方', () => {
    const saved: Array<{ kind: string; json: string }> = []
    const store: CouncilRoutingShadowStore = { saveBanditState: (kind, json) => { saved.push({ kind, json }) } }
    const route = routeCouncilSeat({ authority: 'tianfu' }, { riskTier: 'high' })
    const ev = buildCouncilRoutingShadow({ sessionId: 's1', objectiveHash: 'h1', route, timestamp: 5 })
    persistCouncilRoutingShadow(store, ev)
    assert.equal(saved.length, 1)
    const throwing: CouncilRoutingShadowStore = { saveBanditState: () => { throw new Error('db down') } }
    assert.doesNotThrow(() => persistCouncilRoutingShadow(throwing, ev))
    assert.doesNotThrow(() => persistCouncilRoutingShadow(undefined, ev))
  })
})
