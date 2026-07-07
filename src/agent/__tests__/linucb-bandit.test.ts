import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LinUCBBandit } from '../linucb-bandit.js'

describe('LinUCBBandit', () => {
  it('recommends an arm given context', () => {
    const bandit = new LinUCBBandit({ dimension: 3 })
    bandit.addArm('flash')
    bandit.addArm('pro')
    const ctx = [1, 0, 0.5]
    const rec = bandit.recommend(ctx)
    assert.ok(rec)
    assert.ok(['flash', 'pro'].includes(rec.armId))
  })

  it('learns from accept/reject signals', () => {
    const bandit = new LinUCBBandit({ dimension: 2, alpha: 0.5 })
    bandit.addArm('short')
    bandit.addArm('verbose')

    // User prefers short responses in context [1, 0]
    for (let i = 0; i < 20; i++) {
      bandit.accept('short', [1, 0])
      bandit.reject('verbose', [1, 0])
    }

    const rec = bandit.recommend([1, 0])
    assert.equal(rec?.armId, 'short')
  })

  it('explores during cold start', () => {
    const bandit = new LinUCBBandit({ dimension: 2 })
    bandit.addArm('a')
    bandit.addArm('b')
    // With < 10 pulls, shouldSuggest always returns a recommendation
    const rec = bandit.shouldSuggest([1, 1])
    assert.ok(rec)
  })

  it('serializes and deserializes', () => {
    const bandit = new LinUCBBandit({ dimension: 2 })
    bandit.addArm('x')
    bandit.accept('x', [1, 0])
    bandit.accept('x', [0, 1])

    const json = bandit.serialize()
    const restored = LinUCBBandit.deserialize(json, { dimension: 2 })
    const stats = restored.getStats()
    assert.equal(stats[0]?.pulls, 2)
    assert.ok(stats[0]!.avgReward > 0)
  })

  it('returns null for empty bandit', () => {
    const bandit = new LinUCBBandit({ dimension: 3 })
    assert.equal(bandit.recommend([1, 0, 0]), null)
  })

  it('returns null for wrong dimension context', () => {
    const bandit = new LinUCBBandit({ dimension: 3 })
    bandit.addArm('a')
    assert.equal(bandit.recommend([1, 0]), null) // wrong dim
  })
})
