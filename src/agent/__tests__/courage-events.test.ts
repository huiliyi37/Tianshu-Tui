import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCourageEvent, computeBrightnessChange } from '../courage-events.js'

describe('CourageEvents', () => {
  it('creates event with correct fields', () => {
    const event = createCourageEvent(3, 'risk-warning', 'adopted', () => 123)
    assert.equal(event.ts, 123)
    assert.equal(event.turn, 3)
    assert.equal(event.kind, 'courage-expressed')
    assert.equal(event.detail.type, 'risk-warning')
    assert.equal(event.detail.outcome, 'adopted')
    assert.equal(event.source, 'local')
  })

  it('computes brightness correctly', () => {
    assert.equal(computeBrightnessChange('adopted'), 1)
    assert.equal(computeBrightnessChange('rejected-reasonable'), 0)
    assert.equal(computeBrightnessChange('rejected-proven-right'), 2)
    assert.equal(computeBrightnessChange('marked-noise'), -1)
  })
})
