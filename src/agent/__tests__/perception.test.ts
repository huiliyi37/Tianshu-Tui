import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  adaptThetaInterval,
  applyProviderHealth,
  buildHealthTelemetry,
  buildStarPhaseContext,
  buildTelemetrySnapshot,
} from '../perception.js'
import { createVigorState } from '../vigor.js'
import type { Sensorium, StrategyProfile } from '../sensorium.js'

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    momentum: 0.5,
    pressure: 0.3,
    confidence: 0.8,
    complexity: 0.4,
    freshness: 0.5,
    stability: 1,
    ...overrides,
  }
}

function makeStrategy(overrides: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    reasoningEffort: 'medium',
    explorationBreadth: 0.3,
    commitThreshold: 0.6,
    shouldEscalate: false,
    thetaCycleInterval: 7,
    ...overrides,
  }
}

describe('applyProviderHealth', () => {
  it('returns unchanged sensorium when degradation is zero', () => {
    const sensorium = makeSensorium({ stability: 0.8 })

    assert.deepEqual(applyProviderHealth(sensorium, 0), sensorium)
  })

  it('reduces stability by degradation ratio', () => {
    const adjusted = applyProviderHealth(makeSensorium({ stability: 1 }), 0.5)

    assert.equal(adjusted.stability, 0.85)
  })

  it('clamps degradation ratio to safe range', () => {
    const adjusted = applyProviderHealth(makeSensorium({ stability: 1 }), 2)

    assert.equal(adjusted.stability, 0.7)
  })
})

describe('adaptThetaInterval', () => {
  it('shortens interval as git change rate rises', () => {
    assert.equal(adaptThetaInterval(7, 1), 4)
  })

  it('never goes below floor of two', () => {
    assert.equal(adaptThetaInterval(3, 1), 2)
  })

  it('leaves interval unchanged when git change rate is zero', () => {
    assert.equal(adaptThetaInterval(7, 0), 7)
  })
})

describe('buildStarPhaseContext', () => {
  it('derives writing/testing/final flags from recent tools and turn', () => {
    const ctx = buildStarPhaseContext({
      turn: 9,
      maxTurns: 10,
      recentTools: ['read_file', 'edit_file', 'run_tests'],
      shouldEscalate: true,
      hasEnteredHighComplexity: true,
    })

    assert.deepEqual(ctx, {
      turn: 9,
      isWriting: true,
      isRunningTests: true,
      isFinalTurn: true,
      shouldEscalate: true,
      hasEnteredHighComplexity: true,
    })
  })
})

describe('buildHealthTelemetry', () => {
  it('reports rigidity and elmDue', () => {
    const health = buildHealthTelemetry(createVigorState({
      vigor: 0.86,
      history: [0.81, 0.82, 0.83, 0.84, 0.86, 0.86, 0.86, 0.86, 0.86, 0.86],
    }))

    assert.equal(health.rigidity, true)
    assert.equal(health.elmDue, true)
  })
})

describe('buildTelemetrySnapshot', () => {
  it('builds stable sensorium telemetry shape', () => {
    const snapshot = buildTelemetrySnapshot({
      ts: 123,
      turn: 2,
      phase: 'yuheng-implementing',
      sensorium: makeSensorium({ momentum: 0.9 }),
      strategy: makeStrategy({ reasoningEffort: 'low', thetaCycleInterval: 5 }),
      vigor: createVigorState({ tonic: 0.7, phasic: 0.2, vigor: 0.8 }),
      theta: {
        inFlight: false,
        lastReason: 'elm-micro-release',
        lastDurationMs: 42,
        lastErrorCount: 1,
        lastTimedOut: false,
        requestedCount: 3,
      },
      gitChangeRate: 0.25,
      prefixDrift: true,
    })

    assert.equal(snapshot.ts, 123)
    assert.equal(snapshot.turn, 2)
    assert.equal(snapshot.phase, 'yuheng-implementing')
    assert.equal(snapshot.momentum, 0.9)
    assert.deepEqual(snapshot.strategy, { reasoningEffort: 'low', shouldEscalate: false, thetaInterval: 5 })
    assert.equal(snapshot.vigor.vigor, 0.8)
    assert.equal(snapshot.theta.lastErrorCount, 1)
    assert.equal(snapshot.gitChangeRate, 0.25)
    assert.equal(snapshot.prefixDrift, true)
  })
})
