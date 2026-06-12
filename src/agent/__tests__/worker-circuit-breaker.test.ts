import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { CircuitBreakerManager } from '../worker-circuit-breaker.js'

describe('CircuitBreakerManager', () => {
  let cb: CircuitBreakerManager

  beforeEach(() => {
    cb = new CircuitBreakerManager({ failureThreshold: 3, cheapCooldownMs: 100, defaultCooldownMs: 200 })
  })

  describe('closed state', () => {
    it('allows delegation by default', () => {
      const result = cb.canDelegate('lint_fixer')
      assert.equal(result.allowed, true)
    })

    it('stays closed after fewer failures than threshold', () => {
      cb.recordFailure('lint_fixer')
      cb.recordFailure('lint_fixer')
      assert.equal(cb.getState('lint_fixer').state, 'closed')
      assert.equal(cb.canDelegate('lint_fixer').allowed, true)
    })

    it('resets failure count on success', () => {
      cb.recordFailure('lint_fixer')
      cb.recordFailure('lint_fixer')
      cb.recordSuccess('lint_fixer')
      assert.equal(cb.getState('lint_fixer').failureCount, 0)
    })
  })

  describe('closed → open transition', () => {
    it('trips to open after threshold consecutive failures', () => {
      cb.recordFailure('lint_fixer')
      cb.recordFailure('lint_fixer')
      cb.recordFailure('lint_fixer')
      const state = cb.getState('lint_fixer')
      assert.equal(state.state, 'open')
      assert.equal(state.failureCount, 3)
    })

    it('denies delegation when open', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')
      const result = cb.canDelegate('lint_fixer')
      assert.equal(result.allowed, false)
      assert.ok(result.reason?.includes('circuit open'))
    })
  })

  describe('open → half-open transition (cooldown)', () => {
    it('transitions to half-open after cooldown expires', async () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')
      assert.equal(cb.canDelegate('lint_fixer').allowed, false)

      // Wait for cooldown (100ms for cheap profiles)
      await new Promise(r => setTimeout(r, 150))

      const result = cb.canDelegate('lint_fixer')
      assert.equal(result.allowed, true)
      assert.equal(result.reason, 'half-open probe')
      assert.equal(cb.getState('lint_fixer').state, 'half-open')
    })
  })

  describe('half-open → closed (probe success)', () => {
    it('returns to closed on probe success', async () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')
      await new Promise(r => setTimeout(r, 150))
      cb.canDelegate('lint_fixer') // triggers half-open transition
      cb.recordSuccess('lint_fixer')
      assert.equal(cb.getState('lint_fixer').state, 'closed')
      assert.equal(cb.getState('lint_fixer').failureCount, 0)
    })
  })

  describe('half-open → open (probe failure)', () => {
    it('returns to open on probe failure', async () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')
      await new Promise(r => setTimeout(r, 150))
      cb.canDelegate('lint_fixer') // triggers half-open
      cb.recordFailure('lint_fixer')
      assert.equal(cb.getState('lint_fixer').state, 'open')
    })
  })

  describe('per-profile isolation', () => {
    it('one profile open does not affect another', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')
      assert.equal(cb.canDelegate('lint_fixer').allowed, false)
      assert.equal(cb.canDelegate('type_fixer').allowed, true)
    })
  })

  describe('observability', () => {
    it('getAllStates returns all tracked circuits', () => {
      cb.recordFailure('lint_fixer')
      cb.recordSuccess('type_fixer')
      const states = cb.getAllStates()
      assert.equal(states.length, 2)
      assert.ok(states.some(s => s.profileName === 'lint_fixer'))
      assert.ok(states.some(s => s.profileName === 'type_fixer'))
    })

    it('hasOpenCircuits detects open state', () => {
      assert.equal(cb.hasOpenCircuits(), false)
      for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')
      assert.equal(cb.hasOpenCircuits(), true)
    })
  })

  describe('reset', () => {
    it('reset clears a specific profile', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')
      cb.reset('lint_fixer')
      assert.equal(cb.canDelegate('lint_fixer').allowed, true)
      assert.equal(cb.getState('lint_fixer').state, 'closed')
    })

    it('resetAll clears all circuits', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')
      for (let i = 0; i < 3; i++) cb.recordFailure('type_fixer')
      cb.resetAll()
      assert.equal(cb.hasOpenCircuits(), false)
      assert.equal(cb.getAllStates().length, 0)
    })
  })
})
