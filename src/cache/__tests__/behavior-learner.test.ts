import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CacheBehaviorLearner } from '../behavior-learner.js'

describe('CacheBehaviorLearner', () => {
  it('returns unknown with insufficient observations', () => {
    const learner = new CacheBehaviorLearner()
    learner.observe({ cacheRead: 100, cacheCreation: 50, prefixChanged: false })
    const result = learner.infer()
    assert.equal(result.hasCache, false)
    assert.equal(result.confidence, 0)
  })

  it('detects prefix cache from consistent cache reads', () => {
    const learner = new CacheBehaviorLearner()
    learner.observe({ cacheRead: 0, cacheCreation: 500, prefixChanged: false })
    learner.observe({ cacheRead: 400, cacheCreation: 100, prefixChanged: false })
    learner.observe({ cacheRead: 450, cacheCreation: 50, prefixChanged: false })
    learner.observe({ cacheRead: 480, cacheCreation: 20, prefixChanged: false })

    const result = learner.infer()
    assert.equal(result.hasCache, true)
    assert.ok(result.confidence > 0.3)
  })

  it('detects exact-prefix when prefix change causes miss', () => {
    const learner = new CacheBehaviorLearner()
    learner.observe({ cacheRead: 0, cacheCreation: 500, prefixChanged: false })
    learner.observe({ cacheRead: 400, cacheCreation: 100, prefixChanged: false })
    learner.observe({ cacheRead: 0, cacheCreation: 500, prefixChanged: true })
    learner.observe({ cacheRead: 400, cacheCreation: 100, prefixChanged: false })

    const result = learner.infer()
    assert.equal(result.hasCache, true)
    assert.equal(result.matchingStrategy, 'exact-prefix')
  })

  it('detects no-cache provider', () => {
    const learner = new CacheBehaviorLearner()
    for (let i = 0; i < 10; i++) {
      learner.observe({ cacheRead: 0, cacheCreation: 0, prefixChanged: i % 3 === 0 })
    }
    const result = learner.infer()
    assert.equal(result.hasCache, false)
    assert.ok(result.confidence >= 0.9)
  })
})
