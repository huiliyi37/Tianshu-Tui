import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdaptiveRouter } from '../adaptive-routing.js'
import type { WorkerProfile } from '../work-order.js'

describe('AdaptiveRouter', () => {
  it('starts with no history and returns null scores', () => {
    const router = new AdaptiveRouter()
    assert.equal(router.getScore('code_scout', 'model-a'), null)
  })

  it('records worker outcomes and computes running averages', () => {
    const router = new AdaptiveRouter()
    router.record('code_scout', 'model-a', { passed: true, latencyMs: 500 })
    router.record('code_scout', 'model-a', { passed: true, latencyMs: 700 })
    router.record('code_scout', 'model-a', { passed: false, latencyMs: 200 })

    const score = router.getScore('code_scout', 'model-a')!
    assert.equal(score.totalRuns, 3)
    assert.equal(score.passRate, 2 / 3)
    assert.ok(score.avgLatencyMs > 0)
  })

  it('separates scores by profile and model', () => {
    const router = new AdaptiveRouter()
    router.record('code_scout', 'model-a', { passed: true, latencyMs: 100 })
    router.record('reviewer', 'model-a', { passed: false, latencyMs: 500 })

    assert.equal(router.getScore('code_scout', 'model-a')!.passRate, 1)
    assert.equal(router.getScore('reviewer', 'model-a')!.passRate, 0)
  })

  it('suggests the best model for a given profile', () => {
    const router = new AdaptiveRouter()
    router.record('code_scout', 'fast', { passed: true, latencyMs: 200 })
    router.record('code_scout', 'slow', { passed: true, latencyMs: 2000 })

    const best = router.suggestModel('code_scout', ['fast', 'slow'])
    assert.equal(best, 'fast')
  })

  it('returns null when no data exists for any candidate', () => {
    const router = new AdaptiveRouter()
    assert.equal(router.suggestModel('code_scout', ['model-a']), null)
  })

  it('clears all stats', () => {
    const router = new AdaptiveRouter()
    router.record('code_scout', 'model-a', { passed: true, latencyMs: 100 })
    router.clear()
    assert.equal(router.getScore('code_scout', 'model-a'), null)
  })

  it('caps history per profile+model to prevent unbounded growth', () => {
    const router = new AdaptiveRouter()
    for (let i = 0; i < 200; i++) {
      router.record('code_scout' as WorkerProfile, 'model-a', { passed: true, latencyMs: i })
    }
    const score = router.getScore('code_scout', 'model-a')!
    assert.ok(score.totalRuns <= 100)
  })
})
