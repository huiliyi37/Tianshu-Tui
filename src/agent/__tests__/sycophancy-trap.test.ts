import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSycophancyTrap, buildChallengeHint } from '../sycophancy-trap.js'

describe('sycophancy trap — CVM sycophancy privilege trap', () => {
  it('detects consecutive agreement pattern with declining confidence', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })
    assert.equal(trap.shouldInjectChallenge(), true)
  })

  it('does not trigger when confidence is stable', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.8 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.8 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.8 })
    assert.equal(trap.shouldInjectChallenge(), false)
  })

  it('does not trigger when confidence is increasing', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    assert.equal(trap.shouldInjectChallenge(), false)
  })

  it('resets after disagreement', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.4 })
    trap.recordTurn({ agreedWithUser: false, confidence: 0.6 })
    assert.equal(trap.shouldInjectChallenge(), false)
  })

  it('requires minimum history', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.4 })
    assert.equal(trap.shouldInjectChallenge(), false)
  })

  it('generates challenge hint when triggered', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })
    const hint = trap.getHint()
    assert.ok(hint !== null)
    assert.ok(hint!.length > 0)
  })

  it('returns null hint when not triggered', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.8 })
    assert.equal(trap.getHint(), null)
  })

  it('reset clears history', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })
    assert.equal(trap.shouldInjectChallenge(), true)
    trap.reset()
    assert.equal(trap.shouldInjectChallenge(), false)
  })

  it('window size limits history', () => {
    const trap = createSycophancyTrap()
    // Fill beyond window
    for (let i = 0; i < 10; i++) {
      trap.recordTurn({ agreedWithUser: true, confidence: 0.8 })
    }
    // Last 3 are stable → no trigger
    assert.equal(trap.shouldInjectChallenge(), false)
  })
})

describe('buildChallengeHint', () => {
  it('generates challenge hint', () => {
    const hint = buildChallengeHint()
    assert.ok(hint.length > 0)
  })
})
