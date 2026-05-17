import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapSensoriumToPhase,
  createStarEvent,
  createThetaState,
  tickTheta,
  completeTheta,
  advanceThetaCounter,
  PHASE_LABELS,
  PHASE_GLYPHS,
} from '../star-event.js'
import type { Sensorium } from '../sensorium.js'
import type { StarPhaseContext, ThetaState, StarEvent } from '../star-event.js'

// ─── Phase Labels & Glyphs ──────────────────────────────────────────

describe('PHASE_LABELS', () => {
  it('has all 8 phases', () => {
    const phases: string[] = [
      'tianshu-planning', 'tianxuan-locating', 'tianji-decomposing',
      'tianquan-contracting', 'yuheng-implementing', 'kaiyang-testing',
      'yaoguang-delivering', 'tianshu-encore',
    ]
    for (const p of phases) {
      assert.ok(PHASE_LABELS[p as keyof typeof PHASE_LABELS], `missing label for ${p}`)
      assert.ok(PHASE_GLYPHS[p as keyof typeof PHASE_GLYPHS], `missing glyph for ${p}`)
    }
  })
})

// ─── mapSensoriumToPhase ────────────────────────────────────────────

describe('mapSensoriumToPhase', () => {
  function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
    return {
      momentum: 0.5,
      pressure: 0.3,
      confidence: 0.7,
      complexity: 0.3,
      freshness: 0.5,
      stability: 0.8,
      ...overrides,
    }
  }

  function makeCtx(overrides: Partial<StarPhaseContext> = {}): StarPhaseContext {
    return {
      turn: 3,
      isWriting: false,
      isRunningTests: false,
      isFinalTurn: false,
      shouldEscalate: false,
      ...overrides,
    }
  }

  it('returns kaiyang-testing when running tests', () => {
    const s = makeSensorium()
    const ctx = makeCtx({ isRunningTests: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'kaiyang-testing')
  })

  it('returns yaoguang-delivering on final turn with high momentum', () => {
    const s = makeSensorium({ momentum: 0.9 })
    const ctx = makeCtx({ isFinalTurn: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'yaoguang-delivering')
  })

  it('does not deliver on final turn with low momentum', () => {
    const s = makeSensorium({ momentum: 0.3 })
    const ctx = makeCtx({ isFinalTurn: true })
    assert.notEqual(mapSensoriumToPhase(s, ctx), 'yaoguang-delivering')
  })

  it('returns yuheng-implementing when confident and writing', () => {
    const s = makeSensorium({ confidence: 0.8 })
    const ctx = makeCtx({ isWriting: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'yuheng-implementing')
  })

  it('returns tianji-decomposing when complexity high', () => {
    const s = makeSensorium({ complexity: 0.6 })
    const ctx = makeCtx()
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianji-decomposing')
  })

  it('returns tianxuan-locating when freshness high', () => {
    const s = makeSensorium({ freshness: 0.8, complexity: 0.3 })
    const ctx = makeCtx()
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianxuan-locating')
  })

  it('returns tianshu-planning on first turn with escalation', () => {
    const s = makeSensorium()
    const ctx = makeCtx({ turn: 1, shouldEscalate: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianshu-planning')
  })

  it('returns tianshu-encore on mid-task with low confidence and escalation', () => {
    const s = makeSensorium({ confidence: 0.2 })
    const ctx = makeCtx({ turn: 5, shouldEscalate: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianshu-encore')
  })

  it('testing takes priority over other phases', () => {
    const s = makeSensorium({ momentum: 0.9, confidence: 0.9, complexity: 0.8, freshness: 0.9 })
    const ctx = makeCtx({ isRunningTests: true, isFinalTurn: true, isWriting: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'kaiyang-testing')
  })

  it('encore takes priority over testing', () => {
    const s = makeSensorium({ confidence: 0.1 })
    const ctx = makeCtx({
      turn: 5,
      shouldEscalate: true,
      isRunningTests: true,
    })
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianshu-encore')
  })

  it('delivering takes priority over implementing', () => {
    const s = makeSensorium({ momentum: 0.9, confidence: 0.9 })
    const ctx = makeCtx({ isFinalTurn: true, isWriting: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'yaoguang-delivering')
  })

  it('defaults to locating when freshness above 0.4', () => {
    const s = makeSensorium({ freshness: 0.5 })
    const ctx = makeCtx()
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianxuan-locating')
  })

  it('defaults to planning when freshness low', () => {
    const s = makeSensorium({ freshness: 0.2 })
    const ctx = makeCtx()
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianshu-planning')
  })
})

// ─── createStarEvent ────────────────────────────────────────────────

describe('createStarEvent', () => {
  it('creates a complete StarEvent with all fields', () => {
    const s: Sensorium = {
      momentum: 0.9, pressure: 0.3, confidence: 0.7,
      complexity: 0.3, freshness: 0.5, stability: 0.8,
    }
    const ctx: StarPhaseContext = {
      turn: 5, isFinalTurn: true, isWriting: false,
      isRunningTests: false, shouldEscalate: false,
    }
    const event: StarEvent = createStarEvent(s, ctx)
    assert.equal(event.phase, 'yaoguang-delivering')
    assert.equal(event.turn, 5)
    assert.equal(typeof event.timestamp, 'number')
    assert.ok(event.label.length > 0)
    assert.ok(event.glyph.length > 0)
    assert.deepEqual(event.sensorium, s)
  })

  it('is deterministic', () => {
    const s: Sensorium = {
      momentum: 0.5, pressure: 0.3, confidence: 0.7,
      complexity: 0.3, freshness: 0.5, stability: 0.8,
    }
    const ctx: StarPhaseContext = {
      turn: 1, isFinalTurn: false, isWriting: false,
      isRunningTests: false, shouldEscalate: false,
    }
    const e1 = createStarEvent(s, ctx)
    const e2 = createStarEvent({ ...s }, { ...ctx })
    assert.equal(e1.phase, e2.phase)
    assert.equal(e1.label, e2.label)
    assert.equal(e1.glyph, e2.glyph)
  })
})

// ─── Theta-Gamma Rhythm ─────────────────────────────────────────────

describe('ThetaState', () => {
  it('createThetaState initializes with given interval', () => {
    const state = createThetaState(5)
    assert.equal(state.toolCallCount, 0)
    assert.equal(state.lastThetaAt, 0)
    assert.equal(state.interval, 5)
  })

  it('default interval is 7', () => {
    const state = createThetaState()
    assert.equal(state.interval, 7)
  })

  it('tickTheta returns false before interval reached', () => {
    const state = createThetaState(5)
    // Only 3 tool calls — not yet time
    const s = advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(state)))
    assert.equal(s.toolCallCount, 3)
    assert.equal(tickTheta(s, 0), false)
  })

  it('tickTheta returns true when interval reached', () => {
    const state = createThetaState(3)
    const s = advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(state)))))
    assert.equal(s.toolCallCount, 5)
    assert.equal(tickTheta(s, 0), true)
  })

  it('completeTheta resets lastThetaAt to current count', () => {
    const state: ThetaState = { toolCallCount: 5, lastThetaAt: 0, interval: 3 }
    const after = completeTheta(state)
    assert.equal(after.lastThetaAt, 5)
    // Not time yet (0 steps since last theta)
    assert.equal(tickTheta(after, 0), false)
  })

  it('full cycle: advance → tick → complete → advance again', () => {
    let state = createThetaState(3)

    // 3 tool calls
    state = advanceThetaCounter(state)
    state = advanceThetaCounter(state)
    state = advanceThetaCounter(state)
    assert.equal(tickTheta(state, 0), true)
    state = completeTheta(state)
    assert.equal(tickTheta(state, 0), false)

    // 3 more
    state = advanceThetaCounter(state)
    state = advanceThetaCounter(state)
    state = advanceThetaCounter(state)
    assert.equal(tickTheta(state, 0), true)
  })
})
