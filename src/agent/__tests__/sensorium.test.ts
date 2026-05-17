import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeSensorium, computeStrategy } from '../sensorium.js'
import type { Sensorium, SensoriumInput } from '../sensorium.js'

// ─── computeSensorium ──────────────────────────────────────────────

describe('computeSensorium', () => {
  it('computes momentum from prediction accumulator', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 7 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0.3 },
      evidenceState: { filesModified: 3, verifiedCount: 2 },
      toolCallHistory: ['bash', 'read_file', 'bash', 'write_file', 'bash'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.momentum, 0.7)
    assert.equal(s.pressure, 0.3)
    assert.ok(s.confidence > 0 && s.confidence < 1)
  })

  it('computes momentum as 0 when no predictions yet', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0.1 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.momentum, 0)
  })

  it('computes complexity from tool diversity in sliding window', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0.1 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: ['bash', 'read_file', 'write_file', 'edit_file', 'grep'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.complexity, 1.0) // 5 unique / 5 total
  })

  it('computes low complexity for repeated tools', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0.1 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: ['read_file', 'read_file', 'read_file', 'read_file', 'read_file'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.complexity, 0.2) // 1 unique / 5 total
  })

  it('computes stability from doom level', () => {
    const none: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    assert.equal(computeSensorium(none).stability, 1.0)

    const warn: SensoriumInput = { ...none, doomLevel: 'warn' }
    assert.ok(computeSensorium(warn).stability < 1.0 && computeSensorium(warn).stability > 0.4)

    const blocked: SensoriumInput = { ...none, doomLevel: 'blocked' }
    assert.ok(computeSensorium(blocked).stability < 0.4)
  })

  it('computes confidence from evidence state', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0 },
      evidenceState: { filesModified: 5, verifiedCount: 4 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.confidence, 0.8) // 4/5
  })

  it('confidence defaults to 1.0 when no files modified', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0 },
      evidenceState: { filesModified: 0, verifiedCount: 3 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.confidence, 1.0)
  })

  it('clamps all dimensions to 0-1', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 5, predictions: [], consecutiveCorrect: 20 },
      pressureResult: { tier: 4, shouldCompact: true, thrashing: true, ratio: 1.5 },
      evidenceState: { filesModified: 2, verifiedCount: 10 },
      toolCallHistory: [],
      pheromones: [{ path: 'a.ts', signal: 'well-tested', strength: 1.0, depositedAt: Date.now(), halfLife: 604_800_000 }],
      doomLevel: 'blocked',
    }
    const s = computeSensorium(input)
    assert.ok(s.momentum >= 0 && s.momentum <= 1, `momentum ${s.momentum} out of range`)
    assert.ok(s.pressure >= 0 && s.pressure <= 1, `pressure ${s.pressure} out of range`)
    assert.ok(s.confidence >= 0 && s.confidence <= 1, `confidence ${s.confidence} out of range`)
    assert.ok(s.complexity >= 0 && s.complexity <= 1, `complexity ${s.complexity} out of range`)
    assert.ok(s.freshness >= 0 && s.freshness <= 1, `freshness ${s.freshness} out of range`)
    assert.ok(s.stability >= 0 && s.stability <= 1, `stability ${s.stability} out of range`)
  })

  it('defaults freshness to 0.5 when no pheromones', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.freshness, 0.5)
  })

  it('computes freshness from pheromone average strength', () => {
    const now = Date.now()
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [
        { path: 'a.ts', signal: 'well-tested', strength: 0.8, depositedAt: now, halfLife: 604_800_000 },
        { path: 'b.ts', signal: 'fragile', strength: 0.6, depositedAt: now, halfLife: 604_800_000 },
      ],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.freshness, 0.7) // avg(0.8, 0.6)
  })

  it('handles empty tool history (complexity=0)', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.complexity, 0)
  })

  it('all dimensions are frozen/immutable result', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 5 },
      pressureResult: { tier: 1, shouldCompact: true, thrashing: false, ratio: 0.65 },
      evidenceState: { filesModified: 3, verifiedCount: 2 },
      toolCallHistory: ['bash', 'read_file'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s1 = computeSensorium(input)
    const s2 = computeSensorium({ ...input, predictionAcc: { ...input.predictionAcc, consecutiveCorrect: 9 } })
    assert.notEqual(s1.momentum, s2.momentum) // fresh computation each call
  })
})

// ─── computeStrategy ───────────────────────────────────────────────

describe('computeStrategy', () => {
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

  it('sets reasoningEffort to high when complexity > 0.7', () => {
    const s = makeSensorium({ complexity: 0.8 })
    const profile = computeStrategy(s)
    assert.equal(profile.reasoningEffort, 'high')
  })

  it('sets reasoningEffort to low when momentum > 0.8', () => {
    const s = makeSensorium({ momentum: 0.9, complexity: 0.5 })
    const profile = computeStrategy(s)
    assert.equal(profile.reasoningEffort, 'low')
  })

  it('defaults reasoningEffort to medium', () => {
    const s = makeSensorium()
    const profile = computeStrategy(s)
    assert.equal(profile.reasoningEffort, 'medium')
  })

  it('increases exploration breadth when stability is low', () => {
    const stable = makeSensorium({ stability: 0.8 })
    assert.equal(computeStrategy(stable).explorationBreadth, 0.3)

    const unstable = makeSensorium({ stability: 0.2 })
    assert.equal(computeStrategy(unstable).explorationBreadth, 0.9)
  })

  it('raises commit threshold when pressure is high', () => {
    const lowPressure = makeSensorium({ pressure: 0.3 })
    assert.equal(computeStrategy(lowPressure).commitThreshold, 0.6)

    const highPressure = makeSensorium({ pressure: 0.8 })
    assert.equal(computeStrategy(highPressure).commitThreshold, 0.9)
  })

  it('signals escalation when confidence low and momentum low', () => {
    const normal = makeSensorium({ confidence: 0.5, momentum: 0.5 })
    assert.equal(computeStrategy(normal).shouldEscalate, false)

    const escalateCase = makeSensorium({ confidence: 0.2, momentum: 0.1 })
    assert.equal(computeStrategy(escalateCase).shouldEscalate, true)
  })

  it('does not escalate when only one condition met', () => {
    // Low confidence but good momentum
    const case1 = makeSensorium({ confidence: 0.2, momentum: 0.5 })
    assert.equal(computeStrategy(case1).shouldEscalate, false)

    // Low momentum but good confidence
    const case2 = makeSensorium({ confidence: 0.5, momentum: 0.1 })
    assert.equal(computeStrategy(case2).shouldEscalate, false)
  })

  it('sets shorter theta cycle for complex tasks', () => {
    const simple = makeSensorium({ complexity: 0.3 })
    assert.equal(computeStrategy(simple).thetaCycleInterval, 7)

    const complex = makeSensorium({ complexity: 0.6 })
    assert.equal(computeStrategy(complex).thetaCycleInterval, 3)
  })

  it('returns consistent results for same input', () => {
    const s = makeSensorium({ momentum: 0.4, pressure: 0.6, confidence: 0.3, complexity: 0.7, stability: 0.2 })
    const p1 = computeStrategy(s)
    const p2 = computeStrategy({ ...s })
    assert.deepEqual(p1, p2)
  })

  it('all fields are present in strategy profile', () => {
    const s = makeSensorium()
    const profile = computeStrategy(s)
    const keys = Object.keys(profile).sort()
    assert.deepEqual(keys, ['commitThreshold', 'explorationBreadth', 'reasoningEffort', 'shouldEscalate', 'thetaCycleInterval'])
    assert.equal(typeof profile.reasoningEffort, 'string')
    assert.equal(typeof profile.explorationBreadth, 'number')
    assert.equal(typeof profile.commitThreshold, 'number')
    assert.equal(typeof profile.shouldEscalate, 'boolean')
    assert.equal(typeof profile.thetaCycleInterval, 'number')
  })
})
