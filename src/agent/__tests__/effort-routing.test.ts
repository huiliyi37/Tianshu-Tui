import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { routeRoutineEffort } from '../effort-routing.js'

describe('routeRoutineEffort (Phase 2A)', () => {
  const routine = { complexity: 0.2, momentum: 0.9, confidence: 0.8 }
  const busy = { complexity: 0.8, momentum: 0.4, confidence: 0.3 }

  it('is a no-op when disabled (default)', () => {
    assert.equal(routeRoutineEffort('high', routine, false), 'high')
  })

  it('steps down one tier on a routine on-track turn when enabled', () => {
    assert.equal(routeRoutineEffort('high', routine, true), 'medium')
    assert.equal(routeRoutineEffort('medium', routine, true), 'low')
  })

  it('keeps full effort on a complex / off-track turn even when enabled', () => {
    assert.equal(routeRoutineEffort('high', busy, true), 'high')
  })

  it('routine requires low complexity AND (momentum OR confidence) high', () => {
    // low complexity but neither momentum nor confidence high → not routine
    assert.equal(routeRoutineEffort('high', { complexity: 0.2, momentum: 0.4, confidence: 0.4 }, true), 'high')
    // momentum high alone is enough
    assert.equal(routeRoutineEffort('high', { complexity: 0.2, momentum: 0.8, confidence: 0.1 }, true), 'medium')
    // confidence high alone is enough
    assert.equal(routeRoutineEffort('high', { complexity: 0.2, momentum: 0.1, confidence: 0.8 }, true), 'medium')
    // high complexity blocks routing regardless of momentum/confidence
    assert.equal(routeRoutineEffort('high', { complexity: 0.5, momentum: 0.9, confidence: 0.9 }, true), 'high')
  })

  it('never steps below off; never steps up', () => {
    assert.equal(routeRoutineEffort('off', routine, true), 'off')
    assert.equal(routeRoutineEffort('low', routine, true), 'off')
  })

  it('respects the RIVET_EFFORT_ROUTING env default', () => {
    const prev = process.env['RIVET_EFFORT_ROUTING']
    try {
      delete process.env['RIVET_EFFORT_ROUTING']
      assert.equal(routeRoutineEffort('high', routine), 'high')
      process.env['RIVET_EFFORT_ROUTING'] = '1'
      assert.equal(routeRoutineEffort('high', routine), 'medium')
    } finally {
      if (prev === undefined) delete process.env['RIVET_EFFORT_ROUTING']
      else process.env['RIVET_EFFORT_ROUTING'] = prev
    }
  })
})
