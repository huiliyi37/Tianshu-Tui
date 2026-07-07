import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeHookPipeline } from '../runtime-hooks.js'
import { TurnPerceptionController } from '../turn-perception.js'
import { createVigorState } from '../vigor.js'
import { createThetaState } from '../star-event.js'
import { createTraceStore } from '../trace-store.js'
import { createPredictionAccumulator } from '../prediction-error.js'
import type { EvidenceState } from '../evidence.js'
import type { TelemetryWriter } from '../telemetry-writer.js'
import type { PrefixFingerprint } from '../../prompt/fingerprint.js'

function evidenceState(): EvidenceState {
  return {
    filesRead: new Set(),
    filesModified: new Set(),
    verifications: [],
    deliveryStatus: 'unverified',
    impactedFiles: new Set(),
    impactedTests: new Set(),
  }
}

function fingerprint(hash = 'same'): PrefixFingerprint {
  return {
    systemSha256: hash,
    toolsSha256: hash,
    stableVolatileSha256: hash,
    combinedSha256: hash,
  }
}

function makeInput(turn = 1) {
  return {
    turn,
    estimatedTokens: 100,
    pressureResult: { ratio: 0.1, tier: 0 as const, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false },
    evidenceState: evidenceState(),
    predictionAccumulator: createPredictionAccumulator(),
    recentToolHistory: [],
    loadedPheromones: [],
    traceStore: createTraceStore(),
    gitChangeRate: 0,
    season: null,
    sensorium: null,
    strategy: null,
    vigor: createVigorState(),
    thetaState: createThetaState(7),
    thetaTelemetry: { lastReason: null, lastDurationMs: null, lastErrorCount: 0, lastTimedOut: false, requestedCount: 0 },
    thetaCheckInFlight: false,
    baselineFingerprint: fingerprint('same'),
  }
}

describe('TurnPerceptionController', () => {
  it('runs perception hooks, emits star phase, writes telemetry, and adapts theta interval', async () => {
    const snapshots: unknown[] = []
    const phases: string[] = []
    const writer: TelemetryWriter = { write: snapshot => { snapshots.push(snapshot) }, flush: async () => {} }
    const runtimeHooks = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'perception-test',
      run: ctx => {
        ctx.effects.setSensorium({ momentum: 0.1, pressure: 0.2, confidence: 0.9, complexity: 0.8, freshness: 0.5, stability: 1 })
        ctx.effects.setStrategy({ reasoningEffort: 'high', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 3 })
      },
    }])
    let reasoningEffort = 'medium'
    const controller = new TurnPerceptionController({
      cwd: '/tmp/project',
      maxTurns: 5,
      runtimeHooks,
      telemetryWriter: writer,
      getRuntimeSnapshot: extra => ({ cwd: '/tmp/project', turn: 1, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null, ...extra }),
      getProviderDegradationRatio: () => 0,
      addUserMessage: () => {},
      requestThetaCheck: () => {},
      setReasoningEffort: effort => { reasoningEffort = effort },
      getFingerprint: () => fingerprint('same'),
    })

    const result = await controller.perceive(makeInput(), {
      emitPhaseChange: phase => { phases.push(phase) },
    })

    assert.equal(result.sensorium.complexity, 0.8)
    assert.equal(result.sensoriumInput.fsEventRate, undefined)
    assert.equal(result.strategy.reasoningEffort, 'high')
    assert.equal(result.thetaState.interval, 3)
    assert.equal(reasoningEffort, 'high')
    assert.equal(result.event.phase, 'tianji-decomposing')
    assert.deepEqual(phases, ['tianji-decomposing'])
    assert.equal(snapshots.length, 1)
    assert.equal(controller.getSnapshots().length, 1)
  })

  it('passes filesystem event rate through to sensorium input', async () => {
    let observedFsEventRate: number | undefined
    const writer: TelemetryWriter = { write: () => {}, flush: async () => {} }
    const runtimeHooks = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'perception-fs-rate-test',
      run: ctx => {
        observedFsEventRate = ctx.snapshot.sensoriumInput?.fsEventRate
        ctx.effects.setSensorium({ momentum: 0.1, pressure: 0.2, confidence: 0.9, complexity: 0.1, freshness: 0.5, stability: 1 })
        ctx.effects.setStrategy({ reasoningEffort: 'medium', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 7 })
      },
    }])
    const controller = new TurnPerceptionController({
      cwd: '/tmp/project',
      maxTurns: 5,
      runtimeHooks,
      telemetryWriter: writer,
      getRuntimeSnapshot: extra => ({ cwd: '/tmp/project', turn: 1, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null, ...extra }),
      getProviderDegradationRatio: () => 0,
      addUserMessage: () => {},
      requestThetaCheck: () => {},
      setReasoningEffort: () => {},
      getFingerprint: () => fingerprint('same'),
    })

    const result = await controller.perceive({ ...makeInput(), fsEventRate: 0.75 }, { emitPhaseChange: () => {} })

    assert.equal(result.sensoriumInput.fsEventRate, 0.75)
    assert.equal(observedFsEventRate, 0.75)
  })

  it('keeps only the latest 100 sensorium snapshots', async () => {
    const writer: TelemetryWriter = { write: () => {}, flush: async () => {} }
    const runtimeHooks = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'perception-test',
      run: ctx => {
        ctx.effects.setSensorium({ momentum: 0.1, pressure: 0.2, confidence: 0.9, complexity: 0.1, freshness: 0.5, stability: 1 })
        ctx.effects.setStrategy({ reasoningEffort: 'medium', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 7 })
      },
    }])
    const controller = new TurnPerceptionController({
      cwd: '/tmp/project',
      maxTurns: 200,
      runtimeHooks,
      telemetryWriter: writer,
      getRuntimeSnapshot: extra => ({ cwd: '/tmp/project', turn: 1, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null, ...extra }),
      getProviderDegradationRatio: () => 0,
      addUserMessage: () => {},
      requestThetaCheck: () => {},
      setReasoningEffort: () => {},
      getFingerprint: () => fingerprint('same'),
    })

    for (let turn = 1; turn <= 105; turn++) {
      await controller.perceive(makeInput(turn), { emitPhaseChange: () => {} })
    }

    assert.equal(controller.getSnapshots().length, 100)
    assert.equal(controller.getSnapshots()[0]!.turn, 6)
  })
})
