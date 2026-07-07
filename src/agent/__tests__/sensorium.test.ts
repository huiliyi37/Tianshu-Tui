import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeSensorium, computeStrategy } from '../sensorium.js'
import type { Sensorium, SensoriumInput } from '../sensorium.js'

// ─── computeSensorium ──────────────────────────────────────────────

describe('computeSensorium', () => {
  it('computes momentum from prediction accumulator', () => {
    const input: SensoriumInput = {
      // 滑动窗口口径：窗口内 7 正 3 错 → momentum 0.7（非 consecutiveCorrect/10）。
      // 一次探索性报错不清零，连续多错才压低 momentum。
      predictionAcc: { windowSize: 10, predictions: [true, true, true, true, true, true, true, false, false, false], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0.3 },
      evidenceState: { filesModified: 3, verifiedCount: 2 },
      toolCallHistory: ['bash', 'read_file', 'bash', 'write_file', 'bash'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.momentum, 0.7)
    assert.equal(s.pressure, 0.21) // 0.50*0.3 + 0.30*(1/5) + 0.15*0 + 0.05*0
    assert.ok(s.confidence > 0 && s.confidence < 1)
  })

  it('computes momentum as 0 when no predictions yet', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0.1 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.momentum, 0)
  })

  it('computes complexity via Shannon entropy from tool diversity', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0.1 },
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
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0.1 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: ['read_file', 'read_file', 'read_file', 'read_file', 'read_file'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.complexity, 0) // all same → entropy zero
  })

  it('distinguishes distribution skew (Shannon entropy)', () => {
    // With the old unique/total formula, both would be 2/5 = 0.4.
    // Shannon entropy gives different values for different distributions.
    const skewed: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0.1 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: ['A', 'A', 'A', 'A', 'B'], // 4×A, 1×B
      pheromones: [],
      doomLevel: 'none',
    }
    const balanced: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0.1 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: ['A', 'A', 'A', 'B', 'B'], // 3×A, 2×B
      pheromones: [],
      doomLevel: 'none',
    }
    const s1 = computeSensorium(skewed)
    const s2 = computeSensorium(balanced)
    assert.ok(s1.complexity < s2.complexity,
      `skewed ${s1.complexity.toFixed(3)} should be < balanced ${s2.complexity.toFixed(3)}`)
    assert.ok(s1.complexity > 0 && s2.complexity < 1,
      `skewed=${s1.complexity.toFixed(3)}, balanced=${s2.complexity.toFixed(3)}`)
  })

  it('computes continuous stability from blended signals', () => {
    // Base input: empty predictions, empty tool history, no files modified
    const base: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    // P1b 去饱和：0 改动时 verification 分量是空虚真值，剔除后按剩余权重
    // （0.85）重归一 — 不再吃 +0.15 的虚增。
    // none: (0.40*0.90 + 0.25*0.5 + 0.20*0.5) / 0.85 ≈ 0.688
    const sNone = computeSensorium(base).stability
    assert.ok(sNone > 0.6 && sNone < 0.8, `none stability ${sNone} should be in (0.6, 0.8)`)

    // warn: (0.40*0.50 + 0.25*0.5 + 0.20*0.5) / 0.85 = 0.5
    const sWarn = computeSensorium({ ...base, doomLevel: 'warn' }).stability
    assert.ok(sWarn > 0.40 && sWarn < 0.65, `warn stability ${sWarn} should be in (0.40, 0.65)`)
    assert.ok(sWarn < sNone, 'warn should have lower stability than none')

    // blocked: (0.40*0.10 + 0.25*0.5 + 0.20*0.5) / 0.85 ≈ 0.312
    const sBlocked = computeSensorium({ ...base, doomLevel: 'blocked' }).stability
    assert.ok(sBlocked > 0.20 && sBlocked < 0.50, `blocked stability ${sBlocked} should be in (0.20, 0.50)`)
    assert.ok(sBlocked < sWarn, 'blocked should have lower stability than warn')

    // P1b quality 标注：0 改动 → confidence vacuous / stability partial；
    // 无预测样本 → momentum no-data
    const q = computeSensorium(base).quality!
    assert.equal(q.confidence, 'vacuous')
    assert.equal(q.momentum, 'no-data')
    assert.equal(q.stability, 'partial')
    const qMeasured = computeSensorium({
      ...base,
      evidenceState: { filesModified: 2, verifiedCount: 1 },
      predictionAcc: { windowSize: 10, predictions: [true], consecutiveCorrect: 1 },
    }).quality!
    assert.equal(qMeasured.confidence, 'measured')
    assert.equal(qMeasured.momentum, 'measured')
    assert.equal(qMeasured.stability, 'measured')
  })

  it('stability decreases with low prediction accuracy', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [true, false, false, false, false], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: ['read_file', 'edit_file', 'bash', 'read_file', 'edit_file'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    // predictionRate = 1/5 = 0.2, diversity = 3/5 = 0.6, verificationCoverage = 1.0
    // 0.40*0.90 + 0.25*0.2 + 0.20*0.6 + 0.15*1.0 = 0.36+0.05+0.12+0.15 = 0.68
    assert.ok(s.stability < 0.75, `low predictions should reduce stability, got ${s.stability}`)
    assert.ok(s.stability > 0.55)
  })

  it('stability decreases with low tool diversity (repetition)', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [true, true, true], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: ['read_file', 'read_file', 'read_file', 'read_file', 'read_file'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    // predictionRate = 1.0, diversity = 1/5 = 0.2, verificationCoverage = 1.0
    // 0.40*0.90 + 0.25*1.0 + 0.20*0.2 + 0.15*1.0 = 0.36+0.25+0.04+0.15 = 0.80
    assert.ok(s.stability < 0.85, `low diversity should reduce stability, got ${s.stability}`)
    assert.ok(s.stability > 0.70)
  })

  it('stability decreases with unverified modifications', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [true, true, true], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0 },
      evidenceState: { filesModified: 5, verifiedCount: 1 },
      toolCallHistory: ['read_file', 'edit_file', 'bash', 'grep', 'read_file'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    // predictionRate = 1.0, diversity = 4/5 = 0.8, verificationCoverage = 1/5 = 0.2
    // 0.40*0.90 + 0.25*1.0 + 0.20*0.8 + 0.15*0.2 = 0.36+0.25+0.16+0.03 = 0.80
    assert.ok(s.stability < 0.85, `unverified changes should reduce stability, got ${s.stability}`)
    assert.ok(s.stability > 0.70)
  })

  it('pressure increases with verification debt', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0.2 },
      evidenceState: { filesModified: 5, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    // verificationDebt = (5-0)/max(5,5) = 5/5 = 1.0
    // 0.50*0.2 + 0.30*1.0 + 0.15*0 + 0.05*0 = 0.10 + 0.30 = 0.40
    assert.equal(s.pressure, 0.40)
  })

  it('pressure stays zero when nothing is happening', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.pressure, 0)
  })

  it('pressure incorporates CVM overhead', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0.08, shouldThrottleCvm: true, ratio: 0.1 },
      evidenceState: { filesModified: 0, verifiedCount: 0 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    // 0.50*0.1 + 0.30*0 + 0.15*0.08 + 0.05*0 = 0.05 + 0.012 = 0.062
    assert.ok(s.pressure > 0.05 && s.pressure < 0.08, `CVM overhead should increase pressure, got ${s.pressure}`)
  })

  it('computes confidence from evidence state', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0 },
      evidenceState: { filesModified: 5, verifiedCount: 4 },
      toolCallHistory: [],
      pheromones: [],
      doomLevel: 'none',
    }
    const s = computeSensorium(input)
    assert.equal(s.confidence, 0.8) // 4/5 — verification coverage ratio
  })

  it('verification coverage defaults to 1.0 when no files modified (vacuously true: 0/0)', () => {
    const input: SensoriumInput = {
      predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0 },
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
      pressureResult: { tier: 4, shouldCompact: true, thrashing: true, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 1.5 },
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
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0 },
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
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0 },
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
      pressureResult: { tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0 },
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
      predictionAcc: { windowSize: 10, predictions: [true, true, true, true, true], consecutiveCorrect: 5 },
      pressureResult: { tier: 1, shouldCompact: true, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false, ratio: 0.65 },
      evidenceState: { filesModified: 3, verifiedCount: 2 },
      toolCallHistory: ['bash', 'read_file'],
      pheromones: [],
      doomLevel: 'none',
    }
    const s1 = computeSensorium(input)
    // 滑动窗口口径：改 predictions 数组（非 consecutiveCorrect）才改变 momentum。
    // s1 全对 → momentum 1；s2 混入错误 → momentum < 1，二者不同。
    const s2 = computeSensorium({ ...input, predictionAcc: { ...input.predictionAcc, predictions: [true, true, true, true, true, false, false, false] } })
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
    // explorationBreadth is now a continuous function of stability + complexity
    // (was a binary `stability<0.3 ? 0.9 : 0.3` with a 0.60 cliff). Verify the
    // direction (low stability → wider breadth) and that there is no cliff at
    // the old 0.3 boundary.
    const stable = makeSensorium({ stability: 0.8, complexity: 0.3 })
    const unstable = makeSensorium({ stability: 0.2, complexity: 0.3 })
    assert.ok(
      computeStrategy(unstable).explorationBreadth > computeStrategy(stable).explorationBreadth,
      `unstable breadth should exceed stable`,
    )

    // Continuity: just-below and just-above the old 0.3 cliff must be close,
    // not separated by the old 0.60 jump.
    const justBelow = computeStrategy(makeSensorium({ stability: 0.29, complexity: 0.3 })).explorationBreadth
    const justAbove = computeStrategy(makeSensorium({ stability: 0.31, complexity: 0.3 })).explorationBreadth
    assert.ok(
      Math.abs(justBelow - justAbove) < 0.1,
      `explorationBreadth must be continuous across stability=0.3 (got ${justBelow} vs ${justAbove})`,
    )
  })

  it('raises commit threshold when pressure is high', () => {
    // commitThreshold is now a continuous function of pressure + momentum
    // (was a binary `pressure>0.7 ? 0.9 : 0.6` with a 0.30 cliff). Verify the
    // direction (high pressure → higher threshold) and continuity at 0.7.
    const lowPressure = makeSensorium({ pressure: 0.3, momentum: 0.5 })
    const highPressure = makeSensorium({ pressure: 0.8, momentum: 0.5 })
    assert.ok(
      computeStrategy(highPressure).commitThreshold > computeStrategy(lowPressure).commitThreshold,
      `high pressure should raise commit threshold`,
    )

    // Continuity: just-below and just-above the old 0.7 cliff must be close,
    // not separated by the old 0.30 jump.
    const justBelow = computeStrategy(makeSensorium({ pressure: 0.69, momentum: 0.5 })).commitThreshold
    const justAbove = computeStrategy(makeSensorium({ pressure: 0.71, momentum: 0.5 })).commitThreshold
    assert.ok(
      Math.abs(justBelow - justAbove) < 0.1,
      `commitThreshold must be continuous across pressure=0.7 (got ${justBelow} vs ${justAbove})`,
    )
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
