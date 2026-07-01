import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveHardStallMs } from '../turn-step-producer.js'

describe('resolveHardStallMs (reasoning-aware watchdog ceiling)', () => {
  it('disables the watchdog for GLM independent reasoning', () => {
    assert.equal(resolveHardStallMs({ providerName: 'glm' }), 0)
    // GLM wins even if effort would otherwise raise the ceiling.
    assert.equal(resolveHardStallMs({ providerName: 'glm', reasoningEffort: 'high' }), 0)
  })

  it('raises the ceiling for deep-reasoning sessions (high/max effort)', () => {
    assert.equal(resolveHardStallMs({ providerName: 'deepseek', reasoningEffort: 'high' }), 480_000)
    assert.equal(resolveHardStallMs({ providerName: 'deepseek', reasoningEffort: 'max' }), 480_000)
  })

  it('keeps the tight default for non-reasoning sessions', () => {
    assert.equal(resolveHardStallMs({ providerName: 'deepseek' }), 240_000)
    assert.equal(resolveHardStallMs({ providerName: 'deepseek', reasoningEffort: 'low' }), 240_000)
    assert.equal(resolveHardStallMs({ providerName: 'deepseek', reasoningEffort: 'medium' }), 240_000)
    assert.equal(resolveHardStallMs({}), 240_000)
  })
})
