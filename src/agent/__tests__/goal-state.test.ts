import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateTransition } from '../goal-state.js'
import type { GoalStatus, GoalActor, GoalBudgetLimits, GoalStateRecord } from '../goal-state.js'

describe('validateTransition', () => {
  describe('active → *', () => {
    it('allows active → paused', () => {
      assert.equal(validateTransition('active', 'paused'), true)
    })
    it('allows active → blocked', () => {
      assert.equal(validateTransition('active', 'blocked'), true)
    })
    it('allows active → complete', () => {
      assert.equal(validateTransition('active', 'complete'), true)
    })
    it('rejects active → active (no self-loop)', () => {
      assert.equal(validateTransition('active', 'active'), false)
    })
  })

  describe('paused → *', () => {
    it('allows paused → active', () => {
      assert.equal(validateTransition('paused', 'active'), true)
    })
    it('rejects paused → paused', () => {
      assert.equal(validateTransition('paused', 'paused'), false)
    })
    it('rejects paused → blocked', () => {
      assert.equal(validateTransition('paused', 'blocked'), false)
    })
    it('rejects paused → complete', () => {
      assert.equal(validateTransition('paused', 'complete'), false)
    })
  })

  describe('blocked → *', () => {
    it('allows blocked → active', () => {
      assert.equal(validateTransition('blocked', 'active'), true)
    })
    it('rejects blocked → blocked', () => {
      assert.equal(validateTransition('blocked', 'blocked'), false)
    })
    it('rejects blocked → paused', () => {
      assert.equal(validateTransition('blocked', 'paused'), false)
    })
    it('rejects blocked → complete', () => {
      assert.equal(validateTransition('blocked', 'complete'), false)
    })
  })

  describe('complete → * (terminal)', () => {
    it('rejects complete → active', () => {
      assert.equal(validateTransition('complete', 'active'), false)
    })
    it('rejects complete → paused', () => {
      assert.equal(validateTransition('complete', 'paused'), false)
    })
    it('rejects complete → blocked', () => {
      assert.equal(validateTransition('complete', 'blocked'), false)
    })
    it('rejects complete → complete', () => {
      assert.equal(validateTransition('complete', 'complete'), false)
    })
  })
})

describe('GoalStatus type coverage', () => {
  // Ensure all four states are exercised by validateTransition
  it('covers active/paused/blocked/complete transitions exhaustively', () => {
    const statuses: GoalStatus[] = ['active', 'paused', 'blocked', 'complete']
    // Every valid outgoing transition:
    const validPaths: Array<[GoalStatus, GoalStatus]> = [
      ['active', 'paused'],
      ['active', 'blocked'],
      ['active', 'complete'],
      ['paused', 'active'],
      ['blocked', 'active'],
    ]
    for (const [from, to] of validPaths) {
      assert.equal(validateTransition(from, to), true, `${from}→${to} should be allowed`)
    }
    // All other combinations should be false
    for (const from of statuses) {
      for (const to of statuses) {
        const isValid = validPaths.some(([f, t]) => f === from && t === to)
        if (!isValid) {
          assert.equal(validateTransition(from, to), false, `${from}→${to} should be rejected`)
        }
      }
    }
  })
})

describe('GoalStateRecord shape', () => {
  it('can construct a well-formed record', () => {
    const record: GoalStateRecord = {
      goalId: 'test-uuid',
      objective: 'Fix all bugs',
      status: 'active',
      iterationsUsed: 3,
      wallClockAccumMs: 12345,
      budgetLimits: {
        maxIterations: 10,
        contextWindow: 128000,
      },
      savedAt: Date.now(),
    }
    assert.equal(record.status, 'active')
    assert.equal(record.budgetLimits.maxIterations, 10)
    assert.equal(record.budgetLimits.wallClockMs, undefined)
  })

  it('can include optional wallClockMs in budgetLimits', () => {
    const record: GoalStateRecord = {
      goalId: 'test-uuid',
      objective: 'Fix all bugs',
      status: 'active',
      iterationsUsed: 0,
      wallClockAccumMs: 0,
      budgetLimits: {
        maxIterations: 10,
        contextWindow: 128000,
        wallClockMs: 3600000,
      },
      savedAt: Date.now(),
    }
    assert.equal(record.budgetLimits.wallClockMs, 3600000)
  })

  it('can include optional terminalReason and completionCriterion', () => {
    const record: GoalStateRecord = {
      goalId: 'test-uuid',
      objective: 'Fix all bugs',
      status: 'complete',
      iterationsUsed: 5,
      wallClockAccumMs: 50000,
      budgetLimits: {
        maxIterations: 10,
        contextWindow: 128000,
      },
      terminalReason: 'Goal achieved',
      completionCriterion: 'All tests pass\nNo type errors',
      savedAt: Date.now(),
    }
    assert.equal(record.terminalReason, 'Goal achieved')
    assert.equal(record.completionCriterion, 'All tests pass\nNo type errors')
  })
})
