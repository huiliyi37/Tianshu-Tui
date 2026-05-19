import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FieldHabituationTracker } from '../field-habituation.js'

describe('FieldHabituationTracker', () => {
  it('field stays active until reaching habituation threshold', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })
    for (let i = 0; i < 4; i++) {
      tracker.recordTurn({ domain: 'tianshu-planning' })
    }
    assert.ok(tracker.getActive().has('domain'))
    assert.ok(!tracker.getHabituated().has('domain'))
  })

  it('field promotes to habituated after threshold consecutive stable turns', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })
    for (let i = 0; i < 5; i++) {
      tracker.recordTurn({ domain: 'tianshu-planning' })
    }
    assert.ok(tracker.getHabituated().has('domain'))
    assert.ok(!tracker.getActive().has('domain'))
  })

  it('field demotes on content change (dehabituation)', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })
    for (let i = 0; i < 5; i++) {
      tracker.recordTurn({ domain: 'tianshu-planning' })
    }
    assert.ok(tracker.getHabituated().has('domain'))
    tracker.recordTurn({ domain: 'tianji-decomposing' })
    assert.ok(!tracker.getHabituated().has('domain'))
    assert.ok(tracker.getActive().has('domain'))
  })

  it('counter resets on content change', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })
    for (let i = 0; i < 3; i++) tracker.recordTurn({ domain: 'value-a' })
    tracker.recordTurn({ domain: 'value-b' })
    for (let i = 0; i < 4; i++) tracker.recordTurn({ domain: 'value-b' })
    assert.ok(!tracker.getHabituated().has('domain'))
    tracker.recordTurn({ domain: 'value-b' })
    assert.ok(tracker.getHabituated().has('domain'))
  })

  it('tracks multiple fields independently', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })
    for (let i = 0; i < 5; i++) {
      tracker.recordTurn({
        domain: 'stable',
        lessons: 'stable-lesson',
        toolHistory: `tool-call-${i}`,
      })
    }
    assert.ok(tracker.getHabituated().has('domain'))
    assert.ok(tracker.getHabituated().has('lessons'))
    assert.ok(!tracker.getHabituated().has('toolHistory'))
    assert.ok(tracker.getActive().has('toolHistory'))
  })

  it('getHabituatedContent returns frozen content at promotion time', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })
    for (let i = 0; i < 5; i++) tracker.recordTurn({ domain: 'tianshu-planning' })
    const content = tracker.getHabituatedContent()
    assert.equal(content.get('domain'), 'tianshu-planning')
  })

  it('field absent in a turn is treated as content change', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })
    for (let i = 0; i < 5; i++) tracker.recordTurn({ domain: 'stable' })
    assert.ok(tracker.getHabituated().has('domain'))
    tracker.recordTurn({})
    assert.ok(!tracker.getHabituated().has('domain'))
  })

  it('empty tracker returns empty sets', () => {
    const tracker = new FieldHabituationTracker({ threshold: 5 })
    assert.equal(tracker.getHabituated().size, 0)
    assert.equal(tracker.getActive().size, 0)
  })
})
