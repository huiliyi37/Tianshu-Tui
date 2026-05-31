import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMCTSPlanningHook } from '../hooks/mcts-planning-hook.js'
import { createRuntimeHookContext, type RuntimeHookSnapshot } from '../runtime-hooks.js'
import type { MCTSPlanResult } from '../mcts-planner.js'

function makeSnapshot(turn: number): RuntimeHookSnapshot {
  return {
    cwd: '/tmp',
    turn,
    recentToolHistory: [],
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  }
}

describe('MCTSPlanningHook', () => {
  it('injects all surviving seeds on planning turn', async () => {
    const injected: string[] = []
    let capturedResult: MCTSPlanResult | undefined

    const hook = createMCTSPlanningHook({
      callSeedModel: async (prompt) => `independent approach based on ${prompt.slice(0, 10)}`,
      branches: 3,
      planningTurn: 1,
      getUserMessage: () => 'refactor auth module',
      onResult: (r) => { capturedResult = r },
    })

    const ctx = createRuntimeHookContext(makeSnapshot(1), {
      injectUserMessage: (msg) => injected.push(msg),
    })

    await hook.run(ctx)

    assert.equal(injected.length, 1)
    assert.ok(injected[0]!.includes('mcts-seeds'))
    assert.ok(injected[0]!.includes('Seed 1'))
    assert.ok(injected[0]!.includes('Seed 2'))
    assert.ok(capturedResult !== undefined)
    assert.ok(capturedResult!.seeds.length > 0)
  })

  it('does not run on non-planning turns', async () => {
    const injected: string[] = []
    const hook = createMCTSPlanningHook({
      callSeedModel: async () => 'path',
      planningTurn: 1,
      getUserMessage: () => 'task',
    })

    const ctx = createRuntimeHookContext(makeSnapshot(2), {
      injectUserMessage: (msg) => injected.push(msg),
    })

    await hook.run(ctx)
    assert.equal(injected.length, 0)
  })

  it('warns when all paths are junk', async () => {
    const injected: string[] = []
    const hook = createMCTSPlanningHook({
      callSeedModel: async () => 'auth auth auth OAuth2 auth auth OAuth2 auth',
      branches: 2,
      planningTurn: 1,
      getUserMessage: () => 'auth OAuth2',
    })

    const ctx = createRuntimeHookContext(makeSnapshot(1), {
      injectUserMessage: (msg) => injected.push(msg),
    })

    await hook.run(ctx)
    assert.ok(injected[0]!.includes('WARNING'))
    assert.ok(injected[0]!.includes('pure echo'))
  })
})
