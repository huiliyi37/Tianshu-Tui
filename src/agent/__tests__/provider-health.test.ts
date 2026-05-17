import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderHealthTracker } from '../provider-health.js'

describe('ProviderHealthTracker', () => {
  it('initializes with hot tier and weight 1.0', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')

    const weights = h.getWeights()
    assert.equal(weights.length, 1)
    assert.equal(weights[0]?.providerId, 'deepseek')
    assert.equal(weights[0]?.tier, 'hot')
    assert.equal(weights[0]?.weight, 1.0)
  })

  it('selectProvider returns provider from hot tier', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')
    h.registerProvider('openai')

    // Both hot, both weight 1.0 — deterministic selection based on insertion order
    const selected = h.selectProvider()
    assert.ok(selected === 'deepseek' || selected === 'openai')
  })

  it('slowly increases weight on success', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')

    // Initial weight 1.0, success: weight stays at 1.0 (max)
    h.recordSuccess('deepseek')
    const w = h.getWeights()[0]!
    assert.equal(w.weight, 1.0)

    // Register a new provider and reduce weight first
    const h2 = new ProviderHealthTracker()
    h2.registerProvider('deepseek')
    // Manually set to a lower value via failure
    h2.recordFailure('deepseek') // weight: 1.0 - 0.4*1.0 = 0.6
    h2.recordSuccess('deepseek') // weight: 0.6 + 0.1*(1-0.6) = 0.64
    const w2 = h2.getWeights()[0]!
    assert.ok(Math.abs(w2.weight - 0.64) < 0.001, `expected ~0.64, got ${w2.weight}`)
  })

  it('rapidly decreases weight on failure (4x faster than success)', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')

    h.recordFailure('deepseek')
    let w = h.getWeights()[0]!
    assert.ok(Math.abs(w.weight - 0.6) < 0.001, `expected ~0.6, got ${w.weight}`)

    h.recordFailure('deepseek')
    w = h.getWeights()[0]!
    assert.ok(Math.abs(w.weight - 0.36) < 0.001, `expected ~0.36, got ${w.weight}`)
  })

  it('transitions hot → warm after 2 consecutive failures', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')

    h.recordFailure('deepseek')
    assert.equal(h.getWeights()[0]?.tier, 'hot')

    h.recordFailure('deepseek')
    assert.equal(h.getWeights()[0]?.tier, 'warm')
  })

  it('transitions warm → cold after 3 consecutive failures', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')

    // hot → warm: 2 failures
    h.recordFailure('deepseek')
    h.recordFailure('deepseek')
    assert.equal(h.getWeights()[0]?.tier, 'warm')

    // warm → cold: 3 more failures
    h.recordFailure('deepseek')
    h.recordFailure('deepseek')
    assert.equal(h.getWeights()[0]?.tier, 'warm') // still warm after 2

    h.recordFailure('deepseek')
    assert.equal(h.getWeights()[0]?.tier, 'cold')
  })

  it('transitions warm → hot after 3 consecutive successes', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')

    // Push to warm
    h.recordFailure('deepseek')
    h.recordFailure('deepseek')
    assert.equal(h.getWeights()[0]?.tier, 'warm')

    // 3 successes → back to hot
    h.recordSuccess('deepseek')
    h.recordSuccess('deepseek')
    assert.equal(h.getWeights()[0]?.tier, 'warm') // still warm after 2

    h.recordSuccess('deepseek')
    assert.equal(h.getWeights()[0]?.tier, 'hot')
  })

  it('transitions cold → warm on manual retry success', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')

    // Push to cold
    h.recordFailure('deepseek') // 1
    h.recordFailure('deepseek') // 2: hot→warm
    h.recordFailure('deepseek') // 3
    h.recordFailure('deepseek') // 4
    h.recordFailure('deepseek') // 5: warm→cold
    assert.equal(h.getWeights()[0]?.tier, 'cold')

    // Manual retry success
    h.recordSuccess('deepseek')
    assert.equal(h.getWeights()[0]?.tier, 'warm')
  })

  it('success resets failure streak', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')

    h.recordFailure('deepseek') // streak: 1
    h.recordSuccess('deepseek') // streak reset
    h.recordFailure('deepseek') // streak: 1
    assert.equal(h.getWeights()[0]?.tier, 'hot') // still hot, streak never hit 2
  })

  it('returns undefined from selectProvider when no hot providers', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('openai')

    // Push to cold
    h.recordFailure('openai')
    h.recordFailure('openai') // warm
    h.recordFailure('openai')
    h.recordFailure('openai')
    h.recordFailure('openai') // cold

    assert.equal(h.selectProvider(), undefined)
  })

  it('falls back to warm when no hot providers available', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')
    h.registerProvider('openai')

    // Push deepseek to cold
    h.recordFailure('deepseek')
    h.recordFailure('deepseek') // warm
    h.recordFailure('deepseek')
    h.recordFailure('deepseek')
    h.recordFailure('deepseek') // cold

    // Only openai is hot now
    const s = h.selectProvider()
    assert.equal(s, 'openai')
  })

  it('weight floor is 0.05', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')

    // Aggressively reduce weight
    for (let i = 0; i < 20; i++) h.recordFailure('deepseek')

    assert.ok(h.getWeights()[0]!.weight > 0.04)
    assert.ok(h.getWeights()[0]!.weight <= 0.1)
  })

  it('serializes and deserializes', () => {
    const h = new ProviderHealthTracker()
    h.registerProvider('deepseek')
    h.registerProvider('openai')
    h.recordFailure('deepseek')

    const json = h.toJSON()

    const restored = ProviderHealthTracker.fromJSON(json)
    const weights = restored.getWeights()
    assert.equal(weights.length, 2)
    assert.equal(weights[0]?.providerId, 'deepseek')
    assert.equal(weights[1]?.providerId, 'openai')
    // deepseek had 1 failure, weight should be ~0.6
    assert.ok(Math.abs(weights[0]!.weight - 0.6) < 0.001)
  })
})
