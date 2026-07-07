/**
 * T2-02 P3 地基债 tests:
 *  - Debt 3: applyEffortDelta clamp + reasoningFloor safety gate (via pure
 *    resolveEffortDelta — the only safety gate before P3 activation).
 *  - Debt 2: bandit cross-session restore (importState) actually rehydrates
 *    live instance state.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffortDelta } from '../effort-delta.js'
import { LinUCBBandit } from '../linucb-bandit.js'
import { P3Integration } from '../p3-integration.js'
import { buildEffortContext } from '../p3-reward.js'

// ─── Debt 3: resolveEffortDelta clamp + floor ────────────────────────────

describe('resolveEffortDelta (effort safety gate)', () => {
  it('delta null → baseEffort unchanged', () => {
    assert.equal(resolveEffortDelta('medium', null), 'medium')
  })

  it('delta 0 → baseEffort unchanged', () => {
    assert.equal(resolveEffortDelta('high', 0), 'high')
  })

  it('illegal baseEffort → returned unchanged', () => {
    assert.equal(resolveEffortDelta('turbo', 1), 'turbo')
    assert.equal(resolveEffortDelta('', -1), '')
  })

  it('applies +1 / -1 deltas within range', () => {
    assert.equal(resolveEffortDelta('low', 1), 'medium')
    assert.equal(resolveEffortDelta('high', -1), 'medium')
  })

  it('clamps to upper bound (max) when idx+delta overshoots', () => {
    assert.equal(resolveEffortDelta('high', 5), 'max')
    assert.equal(resolveEffortDelta('max', 1), 'max')
  })

  it('clamps to lower bound (off) when idx+delta undershoots', () => {
    assert.equal(resolveEffortDelta('low', -5), 'off')
    assert.equal(resolveEffortDelta('off', -1), 'off')
  })

  it('reasoningFloor NOT punched through: result below floor → baseEffort', () => {
    // medium(-1)=low, but floor=medium → must not drop, return baseEffort
    assert.equal(resolveEffortDelta('medium', -1, 'medium'), 'medium')
    // high(-2)=low, floor=high → blocked
    assert.equal(resolveEffortDelta('high', -2, 'high'), 'high')
  })

  it('floor allows results at or above the floor', () => {
    // high(-1)=medium, floor=low → allowed (medium >= low)
    assert.equal(resolveEffortDelta('high', -1, 'low'), 'medium')
    // low(+1)=medium, floor=medium → allowed (medium == floor)
    assert.equal(resolveEffortDelta('low', 1, 'medium'), 'medium')
  })

  it('invalid floor string is ignored (no floorIdx match)', () => {
    assert.equal(resolveEffortDelta('high', -1, 'bogus'), 'medium')
  })
})

// ─── Debt 2: bandit cross-session restore ─────────────────────────────────

describe('LinUCBBandit.importState (cross-session restore)', () => {
  it('save → import rehydrates pulls + arm reward into a live instance', () => {
    // Train a source bandit so it accumulates real state.
    const source = new LinUCBBandit({ dimension: 6, alpha: 1.2 })
    source.addArm('delta:0')
    source.addArm('delta:+1')
    const ctx = buildEffortContext({
      taskComplexity: 0.5,
      errorRate: 0.1,
      turnDepth: 0.2,
      fileCount: 3,
      isRepeat: false,
      timeOfDay: 0.5,
    })
    source.accept('delta:+1', ctx)
    source.accept('delta:+1', ctx)
    source.reject('delta:0', ctx)
    const snapshot = source.serialize()
    const sourceStats = source.getStats()

    // Fresh cold-start live instance — no learning yet.
    const live = new LinUCBBandit({ dimension: 6, alpha: 1.2 })
    live.addArm('delta:0')
    const before = live.getStats()
    assert.equal(before.find(s => s.id === 'delta:+1'), undefined, 'cold start has no delta:+1')

    // Restore in place.
    live.importState(snapshot)
    const after = live.getStats()

    // Live instance now reflects the persisted arms + pulls.
    const liveUp = after.find(s => s.id === 'delta:+1')
    assert.ok(liveUp, 'delta:+1 arm restored into live instance')
    assert.equal(liveUp!.pulls, 2, 'pulls restored')
    const srcUp = sourceStats.find(s => s.id === 'delta:+1')!
    assert.equal(liveUp!.avgReward, srcUp.avgReward, 'avgReward matches source')

    const liveZero = after.find(s => s.id === 'delta:0')!
    assert.equal(liveZero.pulls, 1, 'delta:0 reject pull restored')
  })

  it('importState is REPLACE not merge (cold-start arms dropped)', () => {
    const source = new LinUCBBandit({ dimension: 6 })
    source.addArm('persisted-only')
    const snapshot = source.serialize()

    const live = new LinUCBBandit({ dimension: 6 })
    live.addArm('cold-start-only')
    live.importState(snapshot)
    const ids = live.getStats().map(s => s.id)
    assert.deepEqual(ids, ['persisted-only'], 'cold-start arm replaced, not merged')
  })

  it('P3Integration.importEffortBanditState restores via readonly instance', () => {
    // Source P3 trains its effort bandit.
    const sourceP3 = new P3Integration()
    const ctx = buildEffortContext({
      taskComplexity: 0.6,
      errorRate: 0.2,
      turnDepth: 0.3,
      fileCount: 2,
      isRepeat: false,
      timeOfDay: 0.4,
    })
    sourceP3.effortBandit.accept('delta:+1', ctx)
    sourceP3.effortBandit.accept('delta:+1', ctx)
    sourceP3.effortBandit.accept('delta:+1', ctx)
    const snapshot = sourceP3.serializeEffortBandit()

    // Fresh P3 (live), restore in place — effortBandit is readonly so this
    // proves importEffortBanditState mutates the existing instance.
    const liveP3 = new P3Integration()
    const liveRef = liveP3.effortBandit
    liveP3.effortBandit.importState(snapshot)
    assert.equal(liveP3.effortBandit, liveRef, 'same readonly instance, mutated in place')

    const restored = liveP3.getStats().effortBandit.find(s => s.id === 'delta:+1')!
    assert.equal(restored.pulls, 3, 'cross-session pulls survive into live P3')
  })

  it('P3Integration.importBanditState (model_style) symmetric restore', () => {
    const sourceP3 = new P3Integration()
    const ctx = buildEffortContext({
      taskComplexity: 0.5,
      errorRate: 0,
      turnDepth: 0.1,
      fileCount: 1,
      isRepeat: false,
      timeOfDay: 0.5,
    })
    sourceP3.bandit.accept('pro', ctx)
    sourceP3.bandit.accept('pro', ctx)
    const snapshot = sourceP3.serializeBandit()

    const liveP3 = new P3Integration()
    liveP3.bandit.importState(snapshot)
    const restored = liveP3.getStats().bandit.find(s => s.id === 'pro')!
    assert.equal(restored.pulls, 2, 'model_style cross-session pulls survive')
  })
})
