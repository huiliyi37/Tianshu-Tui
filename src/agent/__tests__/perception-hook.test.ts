import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeHookPipeline, createRuntimeHookContext } from '../runtime-hooks.js'
import { createPerceptionRuntimeHook } from '../hooks/perception-hook.js'
import { createKickRuntimeHook } from '../hooks/kick-hook.js'
import type { SensoriumInput } from '../sensorium.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'

function makeInput(overrides: Partial<SensoriumInput> = {}): SensoriumInput {
  return {
    predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 1 },
    pressureResult: { ratio: 0.2, tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false },
    evidenceState: { filesModified: 1, verifiedCount: 1 },
    toolCallHistory: ['read_file', 'edit_file'],
    pheromones: [],
    doomLevel: 'none',
    gitChangeRate: 0,
    season: null,
    ...overrides,
  }
}

describe('createPerceptionRuntimeHook', () => {
  it('computes sensorium and strategy from snapshot sensoriumInput', async () => {
    const ctx = createRuntimeHookContext({
      cwd: '/tmp/project',
      turn: 1,
      recentToolHistory: [],
      sensorium: null,
      sensoriumInput: makeInput({ pressureResult: { ratio: 0.4, tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false } }),
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
    season: null,
    })
    const hook = createPerceptionRuntimeHook()

    await hook.run(ctx)

    assert.ok(ctx.snapshot.sensorium)
    assert.ok(ctx.snapshot.strategy)
    assert.equal(ctx.snapshot.sensorium.pressure, 0.4)
  })

  it('applies provider degradation before computing strategy', async () => {
    const ctx = createRuntimeHookContext({
      cwd: '/tmp/project',
      turn: 1,
      recentToolHistory: [],
      sensorium: null,
      sensoriumInput: makeInput(),
      providerDegradationRatio: 1,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
    season: null,
    })
    const hook = createPerceptionRuntimeHook()

    await hook.run(ctx)

    assert.equal(ctx.snapshot.sensorium?.stability, 0.7)
  })

  it('lets downstream preTurn hooks observe computed sensorium in the same pipeline phase', async () => {
    const messages: string[] = []
    const deposits: PheromoneDeposit[] = []
    const ctx = createRuntimeHookContext({
      cwd: '/tmp/project',
      turn: 3,
      recentToolHistory: [],
      sensorium: null,
      sensoriumInput: makeInput({
        predictionAcc: { windowSize: 10, predictions: [false, false, false], consecutiveCorrect: 0 },
        doomLevel: 'blocked',
        evidenceState: { filesModified: 2, verifiedCount: 0 },
        toolCallHistory: ['bash', 'bash', 'bash'],
      }),
      providerDegradationRatio: 1,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
    season: null,
    }, {
      injectUserMessage: message => { messages.push(message) },
    })
    const pipeline = new RuntimeHookPipeline([
      createPerceptionRuntimeHook(),
      createKickRuntimeHook({ deposit: async d => { deposits.push(d) } }),
    ])

    await pipeline.runPreTurn(ctx)

    assert.ok(ctx.snapshot.sensorium)
    assert.equal(messages.length, 1)
  })
})
