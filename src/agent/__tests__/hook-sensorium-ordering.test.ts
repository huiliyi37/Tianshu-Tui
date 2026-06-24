import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRuntimeHookContext,
  type RuntimeHookPhase,
  type RuntimeHookSnapshot,
} from '../runtime-hooks.js'
import { createDefaultRuntimeHooks } from '../create-runtime-hooks.js'
import { createVigorAfterPerceptionHook, createVigorPostToolHook } from '../hooks/vigor-hook.js'

// Canonical phase execution order — the pipeline runs each phase fully before
// the next (preTurn → afterPerception → postTool → postTurn → postSession).
const PHASE_ORDER: RuntimeHookPhase[] = [
  'preTurn',
  'afterPerception',
  'postTool',
  'postTurn',
  'postSession',
]

function baseDeps() {
  return {
    stigmergyDeposit: async () => {},
    stigmergyQuery: async () => [],
    getEvidenceState: () => ({
      filesRead: new Set<string>(),
      filesModified: new Set<string>(),
      verifications: [],
      deliveryStatus: 'unverified' as const,
      impactedFiles: new Set<string>(),
      impactedTests: new Set<string>(),
    }),
    setLoadedPheromones: () => {},
    getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
    setThetaState: () => {},
    getPredictionAccumulator: () => ({ history: [] }),
  }
}

function nullSensoriumSnapshot(): RuntimeHookSnapshot {
  return {
    cwd: '/tmp/project',
    turn: 1,
    recentToolHistory: [],
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  }
}

// The architecture-review doc (问题10) worried that vigor could read a stale
// sensorium if it were registered before perception. In reality the dependency
// is satisfied two independent ways, both locked in below:
//   1. Phase separation — perception is preTurn, vigor is afterPerception/postTool;
//      the sensorium is produced by the TurnPerceptionController between phases, so
//      vigor always observes a populated snapshot regardless of array order.
//   2. Defensive null-guards — vigor hooks no-op when sensorium is absent, so even a
//      misordering degrades to "no adjustment" rather than a crash or stale read.
describe('hook sensorium dependency: phase contract + defensive no-op', () => {
  it('vigor hooks run in a later phase than perception (sensorium dependency is phase-guaranteed)', () => {
    const hooks = createDefaultRuntimeHooks(baseDeps())

    const perception = hooks.find(h => h.name === 'perception-runtime')
    const vigorAfter = hooks.find(h => h.name === 'vigor-after-perception')
    const vigorPost = hooks.find(h => h.name === 'vigor-post-tool')

    assert.ok(perception, 'perception-runtime must be registered')
    assert.ok(vigorAfter, 'vigor-after-perception must be registered')
    assert.ok(vigorPost, 'vigor-post-tool must be registered')

    const perceptionPhaseIdx = PHASE_ORDER.indexOf(perception!.phase)
    assert.ok(
      PHASE_ORDER.indexOf(vigorAfter!.phase) > perceptionPhaseIdx,
      'vigor-after-perception must execute in a phase after perception',
    )
    assert.ok(
      PHASE_ORDER.indexOf(vigorPost!.phase) > perceptionPhaseIdx,
      'vigor-post-tool must execute in a phase after perception',
    )
  })

  it('vigor hooks must NOT be in preTurn (sensorium is not yet produced there)', () => {
    const hooks = createDefaultRuntimeHooks(baseDeps())
    for (const name of ['vigor-after-perception', 'vigor-post-tool']) {
      const hook = hooks.find(h => h.name === name)
      assert.ok(hook, `${name} must be registered`)
      assert.notEqual(
        hook!.phase,
        'preTurn',
        `${name} reads snapshot.sensorium; running it in preTurn would read an absent sensorium`,
      )
    }
  })

  it('vigor-after-perception leaves strategy untouched when sensorium is absent', async () => {
    const hook = createVigorAfterPerceptionHook()
    let strategySet = false
    const ctx = createRuntimeHookContext(nullSensoriumSnapshot(), {
      setStrategy: () => { strategySet = true },
    })

    await hook.run(ctx) // must not throw

    assert.equal(strategySet, false, 'vigor must not adjust strategy without a sensorium')
  })

  it('vigor-post-tool leaves vigor untouched when sensorium is absent', async () => {
    const hook = createVigorPostToolHook({ getPredictionAccumulator: () => ({ windowSize: 5, predictions: [], consecutiveCorrect: 0 }) })
    let vigorSet = false
    const ctx = createRuntimeHookContext(nullSensoriumSnapshot(), {
      setVigor: () => { vigorSet = true },
    })

    await hook.run(ctx, { name: 'edit_file', success: true }) // must not throw

    assert.equal(vigorSet, false, 'vigor must not recompute vigor state without a sensorium')
  })
})
