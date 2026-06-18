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
    // Switch sets stableCount=1; 3 more matches → stableCount=4 < 5
    for (let i = 0; i < 3; i++) tracker.recordTurn({ domain: 'value-b' })
    assert.ok(!tracker.getHabituated().has('domain'))
    // 4th match after switch → stableCount=5 → habituated
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

describe('v3: confidence accumulator', () => {
  it('confidence increases on consecutive matches with default alpha', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    for (let i = 0; i < 8; i++) {
      tracker.recordTurn({ domain: 'tianshu' })
    }
    const habituated = tracker.getHabituated()
    assert.ok(habituated.has('domain'), 'Should be habituated after 8 turns with alpha=0.2')
  })

  it('confidence resets to zero on value change', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    for (let i = 0; i < 7; i++) {
      tracker.recordTurn({ domain: 'tianshu' })
    }
    tracker.recordTurn({ domain: 'tianji' })
    assert.ok(!tracker.getHabituated().has('domain'))
  })

  it('absent fields decay rather than hard reset', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8, decayRate: 0.3 })
    for (let i = 0; i < 9; i++) {
      tracker.recordTurn({ domain: 'tianshu' })
    }
    assert.ok(tracker.getHabituated().has('domain'), 'Should be habituated after 9 turns')
    // Absent 1 turn — confidence decays by 0.7x
    tracker.recordTurn({})
    assert.ok(!tracker.getHabituated().has('domain'), 'Should lose habituation after absent')
    // Re-appear — recovers in 4 turns from decayed base (0.61 → 0.84)
    // vs 9 turns from zero (0.0 → 0.87), demonstrating Physarum soft-decay advantage
    for (let i = 0; i < 4; i++) {
      tracker.recordTurn({ domain: 'tianshu' })
    }
    assert.ok(tracker.getHabituated().has('domain'), 'Should re-habituate faster from decayed base')
  })
})

describe('v3: phaseHint alpha modulation', () => {
  it('explore phase: 10 turns NOT enough to habituate', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    for (let i = 0; i < 10; i++) {
      tracker.recordTurn({ domain: 'tianshu' }, 'explore')
    }
    assert.ok(!tracker.getHabituated().has('domain'))
  })

  it('execute phase: 4 turns enough to habituate', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    for (let i = 0; i < 4; i++) {
      tracker.recordTurn({ domain: 'tianshu' }, 'execute')
    }
    assert.ok(tracker.getHabituated().has('domain'))
  })

  it('unknown phaseHint falls back to default alpha', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    for (let i = 0; i < 7; i++) {
      tracker.recordTurn({ domain: 'tianshu' }, 'unknown')
    }
    assert.ok(!tracker.getHabituated().has('domain'), '7 turns at alpha=0.2 → ~0.79 < 0.8')
    tracker.recordTurn({ domain: 'tianshu' }, 'unknown')
    assert.ok(tracker.getHabituated().has('domain'), '8 turns → ~0.83 > 0.8')
  })
})

describe('immediatePromote', () => {
  it('promotes a new field on first call', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    const promoted = tracker.immediatePromote('domain', 'tianshu')
    assert.equal(promoted, true)
    assert.ok(tracker.getHabituated().has('domain'))
    assert.equal(tracker.getHabituatedContent().get('domain'), 'tianshu')
  })

  it('returns false when field already habituated with same content', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    tracker.immediatePromote('domain', 'tianshu')
    const again = tracker.immediatePromote('domain', 'tianshu')
    assert.equal(again, false)
  })

  it('re-promotes when content changes', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    tracker.immediatePromote('domain', 'tianshu')
    const changed = tracker.immediatePromote('domain', 'tianxuan')
    assert.equal(changed, true)
    assert.equal(tracker.getHabituatedContent().get('domain'), 'tianxuan')
  })

  it('survives subsequent recordTurn with same content', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    tracker.immediatePromote('domain', 'tianshu')
    tracker.recordTurn({ domain: 'tianshu' })
    assert.ok(tracker.getHabituated().has('domain'), 'still habituated after recordTurn')
  })

  it('demotes when recordTurn sees different content', () => {
    const tracker = new FieldHabituationTracker({ promotionThreshold: 0.8 })
    tracker.immediatePromote('domain', 'tianshu')
    tracker.recordTurn({ domain: 'different' })
    assert.ok(!tracker.getHabituated().has('domain'), 'content change resets habituation')
  })
})
