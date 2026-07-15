import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CacheAdvisor, type DelayCompactDecision } from '../advisor.js'

// W3-C3: shouldDelayCompact decision ledger — observe-only listener records
// every decision with the inputs that produced it. The listener never affects
// the returned decision.

function advisorWithHitRate(hitRate: number): { advisor: CacheAdvisor; decisions: DelayCompactDecision[] } {
  const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
  const decisions: DelayCompactDecision[] = []
  advisor.setDelayDecisionListener(d => decisions.push(d))
  const total = 1000
  advisor.onTurnEnd({
    turn: 1,
    cacheRead: Math.round(total * hitRate),
    cacheCreation: total - Math.round(total * hitRate),
    prefixChanged: false,
    artifactIdsEvicted: [],
    artifactIdsAccessed: [],
  })
  return { advisor, decisions }
}

describe('CacheAdvisor delay-compact decision ledger', () => {
  it('records a protection-branch delay with formula inputs', () => {
    const { advisor, decisions } = advisorWithHitRate(0.9)
    const delayed = advisor.shouldDelayCompact(2, { estimatedTokens: 200_000, contextWindow: 1_000_000 })
    assert.equal(delayed, true)
    const d = decisions.at(-1)!
    assert.equal(d.event, 'compact_delay_decision')
    assert.equal(d.decision, 'delay')
    assert.equal(d.reason, 'protection')
    assert.equal(d.tier, 2)
    assert.equal(d.estimatedTokens, 200_000)
    assert.equal(d.contextWindow, 1_000_000)
    assert.ok(d.protection! > 0.45, 'protection value recorded')
    assert.ok(d.recentHitRate! > 0.85)
  })

  it('records a pressure-allow decision when protection collapses', () => {
    const { advisor, decisions } = advisorWithHitRate(0.9)
    const delayed = advisor.shouldDelayCompact(2, { estimatedTokens: 950_000, contextWindow: 1_000_000 })
    assert.equal(delayed, false)
    const d = decisions.at(-1)!
    assert.equal(d.decision, 'allow')
    assert.equal(d.reason, 'pressure-allow')
  })

  it('records reactive tiers as allow with reason reactive-tier', () => {
    const { advisor, decisions } = advisorWithHitRate(0.99)
    assert.equal(advisor.shouldDelayCompact(3), false)
    assert.equal(decisions.at(-1)!.reason, 'reactive-tier')
  })

  it('records legacy-path decisions when no pressure context is provided', () => {
    const { advisor, decisions } = advisorWithHitRate(0.9)
    assert.equal(advisor.shouldDelayCompact(1), true)
    assert.equal(decisions.at(-1)!.reason, 'legacy-hitrate')
  })

  it('listener errors never affect the decision', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
    advisor.setDelayDecisionListener(() => { throw new Error('ledger down') })
    assert.equal(advisor.shouldDelayCompact(3), false, 'decision survives listener failure')
  })

  it('no listener registered — decisions still work', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
    assert.equal(advisor.shouldDelayCompact(3), false)
  })
})
