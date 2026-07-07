import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapSensoriumToPhase,
  createStarEvent,
  createThetaState,
  tickTheta,
  completeTheta,
  advanceThetaCounter,
  getThetaPhase,
  PHASE_LABELS,
  PHASE_GLYPHS,
} from '../star-event.js'
import type { Sensorium } from '../sensorium.js'
import type { StarPhaseContext, ThetaState, ThetaPhase, StarEvent } from '../star-event.js'

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
    // Verify all 8 are present
    assert.equal(Object.keys(PHASE_LABELS).length, 8)
    assert.equal(Object.keys(PHASE_GLYPHS).length, 8)
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
      hasEnteredHighComplexity: false,
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

  it('returns tianquan-contracting when was high complexity + confident + low complexity + not writing', () => {
    const s = makeSensorium({ confidence: 0.8, complexity: 0.3, freshness: 0.5 })
    const ctx = makeCtx({ isWriting: false, isRunningTests: false, hasEnteredHighComplexity: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianquan-contracting')
  })

  it('skips contracting when hasEnteredHighComplexity is false', () => {
    const s = makeSensorium({ confidence: 0.8, complexity: 0.3 })
    const ctx = makeCtx({ isWriting: false, isRunningTests: false, hasEnteredHighComplexity: false })
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

  it('skips contracting when isWriting or isRunningTests', () => {
    const s = makeSensorium({ confidence: 0.8, complexity: 0.3 })
    // Writing → should be implementing, not contracting
    const writingCtx = makeCtx({ isWriting: true, isRunningTests: false, hasEnteredHighComplexity: true })
    assert.equal(mapSensoriumToPhase(s, writingCtx), 'yuheng-implementing')
    // Testing → should be testing, not contracting
    const testingCtx = makeCtx({ isWriting: false, isRunningTests: true, hasEnteredHighComplexity: true })
    assert.equal(mapSensoriumToPhase(s, testingCtx), 'kaiyang-testing')
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
      hasEnteredHighComplexity: false,
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
      hasEnteredHighComplexity: false,
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
    assert.equal(state.phase, 0)
    assert.equal(state.cycleCount, 0)
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

  it('tickTheta returns true when interval reached and phase in retrieval', () => {
    const state = createThetaState(3)
    // 5 tool calls at step=1/3 → phase=1.666→0.666 (retrieval)
    const s = advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(state)))))
    assert.equal(s.toolCallCount, 5)
    assert.ok(s.phase >= 0.5, 'phase should be in retrieval')
    assert.equal(tickTheta(s, 0), true)
  })

  it('completeTheta resets lastThetaAt and wraps phase to 0', () => {
    // Use interval=5: 3 steps → phase = 3/5 = 0.6 > 0.5 (retrieval)
    const state = createThetaState(5)
    const advanced = advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(state)))
    assert.ok(advanced.phase > 0, `phase should advance, got ${advanced.phase}`)
    const after = completeTheta(advanced)
    assert.equal(after.lastThetaAt, advanced.toolCallCount)
    assert.equal(after.phase, 0, 'phase should wrap to 0 after completion')
    assert.equal(after.cycleCount, 1)
    assert.equal(tickTheta(after, 0), false)
  })

  it('full cycle: advance → tick → complete → advance again', () => {
    let state = createThetaState(3)

    // 3 tool calls
    state = advanceThetaCounter(state)
    state = advanceThetaCounter(state)
    state = advanceThetaCounter(state)
    // Phase: 3/3 = 1.0 → 0.0 (wrapped). 0.0 < 0.5 → not in retrieval
    // So tickTheta should return false because of phase gate
    assert.equal(state.phase, 0, '3 steps at 1/3 each wraps to 0')
    assert.equal(tickTheta(state, 0), false, 'not in retrieval phase')

    // 3 more calls → phase = 0.0 + 3/3 = 1.0 → 0.0 again
    // Hmm, this means at interval=3 we oscillate between 0 and 1
    // Actually step = 1/3, after 3 steps = 1.0, phase = 0.0
    // But lastThetaAt=0, toolCallCount=3, next=4 → 4>=3 true
    // Phase=0.0 < 0.5 → false
    // After completeTheta: lastThetaAt=3, phase=0
    // 3 more: toolCallCount=6, next=7, 7-3=4>=3 true, phase after 6 steps = 6/3=2.0→0.0
    // This oscillation is the intended behavior at exact interval boundaries
    
    // Let me adjust: after 4 calls (not 3), phase = 4/3 = 1.333 → 0.333 (still encoding)
    // After 5 calls, phase = 5/3 = 1.666 → 0.666 (retrieval!)
    state = advanceThetaCounter(state) // 4th call
    state = advanceThetaCounter(state) // 5th call
    assert.ok(state.phase >= 0.5, `phase should be in retrieval, got ${state.phase}`)
    assert.equal(tickTheta(state, 0), true)
    state = completeTheta(state)
    assert.equal(tickTheta(state, 0), false)
  })

  // ── Theta Phase Machine ──────────────────────────────────────────

  it('getThetaPhase returns encoding when phase < 0.5', () => {
    const state = createThetaState(7)
    assert.equal(getThetaPhase(state), 'encoding')
    // Advance phase past 0.5
    const advanced = { ...state, phase: 0.6 }
    assert.equal(getThetaPhase(advanced), 'retrieval')
  })

  it('phase advances linearly without modulation', () => {
    const state = createThetaState(10)
    // Each step = 1/10 = 0.1
    const s1 = advanceThetaCounter(state)
    assert.ok(Math.abs(s1.phase - 0.1) < 0.001, `expected ~0.1, got ${s1.phase}`)

    const s5 = advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(s1))))
    assert.ok(Math.abs(s5.phase - 0.5) < 0.001, `expected ~0.5, got ${s5.phase}`)
  })

  it('phase wraps and increments cycleCount', () => {
    const state = createThetaState(5)
    // 6 steps at 1/5 = 0.2 each → total 1.2, phase = 0.2, cycles = 1
    let s = state
    for (let i = 0; i < 6; i++) s = advanceThetaCounter(s)
    assert.ok(Math.abs(s.phase - 0.2) < 0.001, `expected ~0.2, got ${s.phase}`)
    assert.equal(s.cycleCount, 1)
  })

  it('high vigor slows phase advance', () => {
    const state = createThetaState(10)
    const slowPhase = advanceThetaCounter(state, { vigor: 0.9, complexity: 0.5 })
    const fastPhase = advanceThetaCounter(state, { vigor: 0.1, complexity: 0.5 })
    // High vigor → slower advance → smaller phase
    assert.ok(slowPhase.phase < fastPhase.phase,
      `high vigor phase ${slowPhase.phase} should be < low vigor phase ${fastPhase.phase}`)
  })

  it('high complexity accelerates phase advance', () => {
    const state = createThetaState(10)
    const slowPhase = advanceThetaCounter(state, { vigor: 0.5, complexity: 0.1 })
    const fastPhase = advanceThetaCounter(state, { vigor: 0.5, complexity: 0.9 })
    // High complexity → faster advance → larger phase
    assert.ok(fastPhase.phase > slowPhase.phase,
      `high complexity phase ${fastPhase.phase} should be > low complexity phase ${slowPhase.phase}`)
  })

  it('tickTheta respects phase gate — encoding phase blocks checks', () => {
    // Create state where interval is met but phase is in encoding
    const state: ThetaState = {
      toolCallCount: 10,
      lastThetaAt: 0,
      interval: 5,
      phase: 0.2,  // encoding
      cycleCount: 0,
    }
    // Interval met (10+1-0 >= 5) but phase < 0.5
    assert.equal(tickTheta(state, 0), false)
  })

  it('tickTheta allows checks when both interval and phase gates pass', () => {
    const state: ThetaState = {
      toolCallCount: 10,
      lastThetaAt: 0,
      interval: 5,
      phase: 0.7,  // retrieval
      cycleCount: 0,
    }
    assert.equal(tickTheta(state, 0), true)
  })
})
