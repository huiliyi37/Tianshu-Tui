import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeEffortWithOverlay,
  minEffort,
  toolFamilyEffortOverlay,
  TOOL_FAMILY_EFFORT_CAP,
} from '../effort-overlay.js'
import { routeRoutineEffort } from '../effort-routing.js'

describe('effort overlay', () => {
  it('tool family caps: read/find → low, write → medium, run → high', () => {
    assert.equal(TOOL_FAMILY_EFFORT_CAP.read, 'low')
    assert.equal(TOOL_FAMILY_EFFORT_CAP.find, 'low')
    assert.equal(TOOL_FAMILY_EFFORT_CAP.write, 'medium')
    assert.equal(TOOL_FAMILY_EFFORT_CAP.run, 'high')
  })

  it('toolFamilyEffortOverlay takes max cap over recent tools', () => {
    assert.equal(toolFamilyEffortOverlay(['read_file', 'grep']), 'low')
    assert.equal(toolFamilyEffortOverlay(['read_file', 'edit_file']), 'medium')
    assert.equal(toolFamilyEffortOverlay(['bash', 'grep']), 'high')
    assert.equal(toolFamilyEffortOverlay([]), undefined)
  })

  it('compose takes min of base, routed, overlay', () => {
    assert.equal(composeEffortWithOverlay('high', 'medium', 'low'), 'low')
    assert.equal(composeEffortWithOverlay('high', 'high', undefined), 'high')
    assert.equal(composeEffortWithOverlay('max', 'high', 'medium'), 'medium')
  })

  it('minEffort prefers the cheaper tier', () => {
    assert.equal(minEffort('high', 'low'), 'low')
    assert.equal(minEffort('off', 'max'), 'off')
  })

  it('integrates with routeRoutineEffort: routine + read overlay → further min', () => {
    const routine = { complexity: 0.2, momentum: 0.9, confidence: 0.8 }
    const routed = routeRoutineEffort('high', routine, true) // → medium
    const overlay = toolFamilyEffortOverlay(['read_file', 'grep']) // → low
    assert.equal(composeEffortWithOverlay('high', routed, overlay), 'low')
  })
})
