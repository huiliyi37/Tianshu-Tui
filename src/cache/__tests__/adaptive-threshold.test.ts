import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdaptiveThresholdController } from '../adaptive-threshold.js'
import { GhostRegistry } from '../ghost-registry.js'

describe('AdaptiveThresholdController', () => {
  it('increases artifact threshold when cache hit rate is high', () => {
    const ghost = new GhostRegistry()
    const ctrl = new AdaptiveThresholdController({ ghostRegistry: ghost })
    const state = ctrl.adjust(0.9, 5)
    assert.ok(state.artifactThreshold > 800, `expected > 800, got ${state.artifactThreshold}`)
  })

  it('decreases artifact threshold when cache hit rate is low', () => {
    const ghost = new GhostRegistry()
    const ctrl = new AdaptiveThresholdController({ ghostRegistry: ghost })
    const state = ctrl.adjust(0.2, 5)
    assert.ok(state.artifactThreshold < 800, `expected < 800, got ${state.artifactThreshold}`)
  })

  it('increases threshold when ghost hits are frequent', () => {
    const ghost = new GhostRegistry()
    ghost.record({ artifactId: 'a1', tool: 'read_file', target: 'x', evictedAtTurn: 3, originalTokens: 200 })
    ghost.record({ artifactId: 'a2', tool: 'bash', target: 'y', evictedAtTurn: 4, originalTokens: 150 })
    ghost.markAccessed('a1', 5)
    ghost.markAccessed('a2', 5)

    const ctrl = new AdaptiveThresholdController({ ghostRegistry: ghost })
    const state = ctrl.adjust(0.5, 5)
    assert.ok(state.artifactThreshold > 800)
    assert.ok(state.stalePreviewChars > 1200)
  })

  it('clamps thresholds within bounds', () => {
    const ghost = new GhostRegistry()
    const ctrl = new AdaptiveThresholdController({ ghostRegistry: ghost })
    for (let i = 0; i < 20; i++) ctrl.adjust(0.95, i)
    const state = ctrl.adjust(0.95, 20)
    assert.ok(state.artifactThreshold <= 4000)
    assert.ok(state.stalePreviewChars <= 2400)
  })

  it('returns defaults on neutral conditions', () => {
    const ghost = new GhostRegistry()
    const ctrl = new AdaptiveThresholdController({ ghostRegistry: ghost })
    const state = ctrl.adjust(0.6, 5)
    assert.equal(state.artifactThreshold, 800)
    assert.equal(state.artifactErrorThreshold, 1600)
    assert.equal(state.stalePreviewChars, 1200)
  })
})
