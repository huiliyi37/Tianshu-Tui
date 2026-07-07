import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CacheAdvisor } from '../advisor.js'

describe('CacheAdvisor', () => {
  it('initializes with default thresholds', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
    const threshold = advisor.getArtifactThreshold('execute', false)
    assert.equal(threshold, 800)
  })

  it('adjusts thresholds after turn with high hit rate', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
    advisor.onTurnEnd({
      turn: 1, cacheRead: 900, cacheCreation: 100,
      prefixChanged: false, artifactIdsEvicted: [], artifactIdsAccessed: [],
    })
    const threshold = advisor.getArtifactThreshold('execute', false)
    assert.ok(threshold >= 800)
  })

  it('records ghost and detects re-access', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
    advisor.onTurnEnd({
      turn: 1, cacheRead: 500, cacheCreation: 500,
      prefixChanged: false, artifactIdsEvicted: ['a1', 'a2'], artifactIdsAccessed: [],
    })
    advisor.onTurnEnd({
      turn: 2, cacheRead: 500, cacheCreation: 500,
      prefixChanged: false, artifactIdsEvicted: [], artifactIdsAccessed: ['a1', 'a2'],
    })
    const threshold = advisor.getArtifactThreshold('execute', false)
    assert.ok(threshold > 800)
  })

  it('discovers cache behavior from observations', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'none', persistent: false } })
    advisor.onTurnEnd({ turn: 1, cacheRead: 0, cacheCreation: 500, prefixChanged: false, artifactIdsEvicted: [], artifactIdsAccessed: [] })
    advisor.onTurnEnd({ turn: 2, cacheRead: 400, cacheCreation: 100, prefixChanged: false, artifactIdsEvicted: [], artifactIdsAccessed: [] })
    advisor.onTurnEnd({ turn: 3, cacheRead: 450, cacheCreation: 50, prefixChanged: false, artifactIdsEvicted: [], artifactIdsAccessed: [] })
    advisor.onTurnEnd({ turn: 4, cacheRead: 480, cacheCreation: 20, prefixChanged: false, artifactIdsEvicted: [], artifactIdsAccessed: [] })

    const diag = advisor.getDiagnostic()
    assert.equal(diag.discoveredBehavior.hasCache, true)
  })

  it('shouldDelayCompact returns true when cache is healthy', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
    for (let i = 0; i < 5; i++) {
      advisor.onTurnEnd({ turn: i, cacheRead: 900, cacheCreation: 100, prefixChanged: false, artifactIdsEvicted: [], artifactIdsAccessed: [] })
    }
    assert.equal(advisor.shouldDelayCompact(1), true)
    assert.equal(advisor.shouldDelayCompact(3), false)
  })

  it('getCompactStrategy upgrades from aggressive when cache discovered', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'none', persistent: false } })
    assert.equal(advisor.getCompactStrategy(), 'aggressive')

    for (let i = 0; i < 5; i++) {
      advisor.onTurnEnd({ turn: i, cacheRead: i > 0 ? 400 : 0, cacheCreation: 100, prefixChanged: false, artifactIdsEvicted: [], artifactIdsAccessed: [] })
    }
    const strategy = advisor.getCompactStrategy()
    assert.ok(strategy === 'balanced' || strategy === 'cache-preserving')
  })

  it('phase multiplier affects threshold', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
    advisor.onTurnEnd({ turn: 0, cacheRead: 500, cacheCreation: 500, prefixChanged: false, artifactIdsEvicted: [], artifactIdsAccessed: [] })

    const explore = advisor.getArtifactThreshold('explore', false)
    const verify = advisor.getArtifactThreshold('verify', false)
    assert.ok(verify > explore, `verify (${verify}) should be > explore (${explore})`)
  })
})
