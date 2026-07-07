import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultRuntimeHooks } from '../create-runtime-hooks.js'
import { createRuntimeHookContext, RuntimeHookPipeline } from '../runtime-hooks.js'
import type { TelemetryWriter } from '../telemetry-writer.js'
import { getPhysarumShadowStatsFromDb } from '../../repo/physarum-shadow-stats.js'
import type { PhysarumPredictionObservation } from '../../repo/physarum-types.js'

function baseHookDeps(overrides: Partial<Parameters<typeof createDefaultRuntimeHooks>[0]> = {}): Parameters<typeof createDefaultRuntimeHooks>[0] {
  return {
    stigmergyDeposit: async () => {},
    stigmergyQuery: async () => [],
    getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
    setLoadedPheromones: () => {},
    getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
    setThetaState: () => {},
    getPredictionAccumulator: () => ({ history: [] }),
    ...overrides,
  }
}

function makeCtx() {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: 3,
    recentToolHistory: [],
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  })
}

describe('physarum shadow telemetry', () => {
  it('exposes next-step hit rates via telemetry postTurn hook', async () => {
    const writes: any[] = []
    const observations: PhysarumPredictionObservation[] = [
      { sourceFile: 'src/a.ts', predictedAtTurn: 1, predictions: [{ file: 'src/b.ts', score: 1 }], observedFile: 'src/b.ts', observedAtTurn: 2, hitRank: 1, leadTurns: 1 },
      { sourceFile: 'src/b.ts', predictedAtTurn: 2, predictions: [{ file: 'src/c.ts', score: 1 }, { file: 'src/d.ts', score: 0.8 }, { file: 'src/e.ts', score: 0.6 }], observedFile: 'src/e.ts', observedAtTurn: 3, hitRank: 3, leadTurns: 1 },
      { sourceFile: 'src/e.ts', predictedAtTurn: 3, predictions: [{ file: 'src/f.ts', score: 1 }], observedFile: 'src/g.ts', observedAtTurn: 4, hitRank: null, leadTurns: 1 },
    ]
    const telemetryWriter: TelemetryWriter = { write: snapshot => { writes.push(snapshot) }, flush: async () => {} }
    const hooks = createDefaultRuntimeHooks(baseHookDeps({
      telemetryWriter,
      getPhysarumShadowStats: () => getPhysarumShadowStatsFromDb({ getPhysarumPredictionObservations: () => observations }),
    }))

    await new RuntimeHookPipeline(hooks).runPostTurn(makeCtx())

    const telemetry = writes.find(w => w.phase === 'physarum-shadow-stats')
    assert.ok(telemetry)
    assert.equal(telemetry.semantic, 'next-step')
    assert.equal(telemetry.total, 3)
    assert.equal(telemetry.hitAt1, 1 / 3)
    assert.equal(telemetry.hitAt3, 2 / 3)
    assert.equal(telemetry.miss, 1)
  })

  it('keeps shadow telemetry no-op when DB stats are unavailable', async () => {
    const writes: any[] = []
    const telemetryWriter: TelemetryWriter = { write: snapshot => { writes.push(snapshot) }, flush: async () => {} }
    const hooks = createDefaultRuntimeHooks(baseHookDeps({
      telemetryWriter,
      getPhysarumShadowStats: () => getPhysarumShadowStatsFromDb(null),
    }))

    await new RuntimeHookPipeline(hooks).runPostTurn(makeCtx())

    assert.equal(writes.some(w => w.phase === 'physarum-shadow-stats'), false)
  })
})
