import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createBlindExplorationHook } from '../hooks/blind-exploration-hook.js'
import { createRuntimeHookContext, type RuntimeHookSnapshot } from '../runtime-hooks.js'

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

describe('BlindExplorationHook', () => {
  it('injects exploration message on turn 1', () => {
    const hook = createBlindExplorationHook()
    const injected: string[] = []
    const ctx = createRuntimeHookContext(makeSnapshot(1), {
      injectUserMessage: (msg) => injected.push(msg),
    })
    hook.run(ctx)
    assert.equal(injected.length, 1)
    assert.ok(injected[0]!.includes('blind-exploration'))
  })

  it('does not inject on turn 2 by default', () => {
    const hook = createBlindExplorationHook()
    const injected: string[] = []
    const ctx = createRuntimeHookContext(makeSnapshot(2), {
      injectUserMessage: (msg) => injected.push(msg),
    })
    hook.run(ctx)
    assert.equal(injected.length, 0)
  })

  it('respects custom activeTurns', () => {
    const hook = createBlindExplorationHook({ activeTurns: [2, 3] })
    const injected: string[] = []
    const ctx1 = createRuntimeHookContext(makeSnapshot(1), {
      injectUserMessage: (msg) => injected.push(msg),
    })
    hook.run(ctx1)
    assert.equal(injected.length, 0)

    const ctx2 = createRuntimeHookContext(makeSnapshot(2), {
      injectUserMessage: (msg) => injected.push(msg),
    })
    hook.run(ctx2)
    assert.equal(injected.length, 1)
  })
})
