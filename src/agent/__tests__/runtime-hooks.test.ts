import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeHookPipeline,
  createRuntimeHookContext,
} from '../runtime-hooks.js'
import type {
  AfterPerceptionRuntimeHook,
  PostSessionRuntimeHook,
  PostToolRuntimeHook,
  PostTurnRuntimeHook,
  PreTurnRuntimeHook,
  RuntimeHookContext,
  RuntimeHookError,
} from '../runtime-hooks.js'

function makeContext(): RuntimeHookContext {
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

describe('RuntimeHookPipeline', () => {
  it('runs preTurn hooks in registration order', async () => {
    const order: string[] = []
    const hookA: PreTurnRuntimeHook = { phase: 'preTurn', name: 'a', run: async () => { order.push('a') } }
    const hookB: PreTurnRuntimeHook = { phase: 'preTurn', name: 'b', run: async () => { order.push('b') } }
    const pipeline = new RuntimeHookPipeline([hookA, hookB])

    await pipeline.runPreTurn(makeContext())

    assert.deepEqual(order, ['a', 'b'])
  })

  it('runs afterPerception hooks after sensorium/strategy are available', async () => {
    const seen: string[] = []
    const hook: AfterPerceptionRuntimeHook = {
      phase: 'afterPerception',
      name: 'vigor-strategy',
      run: async (ctx) => {
        seen.push(ctx.snapshot.sensorium ? 'sensorium' : 'missing')
        seen.push(ctx.snapshot.strategy ? 'strategy' : 'missing')
      },
    }
    const ctx = createRuntimeHookContext({
      cwd: '/tmp/project',
      turn: 1,
      recentToolHistory: [],
      sensorium: { momentum: 0.5, pressure: 0.2, confidence: 0.9, complexity: 0.2, freshness: 0.5, stability: 1 },
      strategy: { reasoningEffort: 'medium', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 7 },
      vigor: null,
      gitChangeRate: 0,
    season: null,
    })
    const pipeline = new RuntimeHookPipeline([hook])

    await pipeline.runAfterPerception(ctx)

    assert.deepEqual(seen, ['sensorium', 'strategy'])
  })

  it('passes postTool events to postTool hooks', async () => {
    const events: string[] = []
    const hook: PostToolRuntimeHook = {
      phase: 'postTool',
      name: 'learner',
      run: async (_ctx, tool) => {
        events.push(`${tool.name}:${tool.success ? 'ok' : 'err'}:${tool.target ?? 'none'}`)
      },
    }
    const pipeline = new RuntimeHookPipeline([hook])

    await pipeline.runPostTool(makeContext(), { name: 'read_file', success: true, target: 'src/a.ts' })

    assert.deepEqual(events, ['read_file:ok:src/a.ts'])
  })

  it('runs postTurn hooks in registration order', async () => {
    const order: string[] = []
    const hookA: PostTurnRuntimeHook = { phase: 'postTurn', name: 'a', run: async () => { order.push('a') } }
    const hookB: PostTurnRuntimeHook = { phase: 'postTurn', name: 'b', run: async () => { order.push('b') } }
    const pipeline = new RuntimeHookPipeline([hookA, hookB])

    await pipeline.runPostTurn(makeContext())

    assert.deepEqual(order, ['a', 'b'])
  })

  it('runs postSession hooks in registration order', async () => {
    const order: string[] = []
    const hookA: PostSessionRuntimeHook = { phase: 'postSession', name: 'a', run: async () => { order.push('a') } }
    const hookB: PostSessionRuntimeHook = { phase: 'postSession', name: 'b', run: async () => { order.push('b') } }
    const pipeline = new RuntimeHookPipeline([hookA, hookB])

    await pipeline.runPostSession(makeContext())

    assert.deepEqual(order, ['a', 'b'])
  })

  it('isolates hook errors and continues later hooks', async () => {
    const order: string[] = []
    const errors: RuntimeHookError[] = []
    const bad: PreTurnRuntimeHook = { phase: 'preTurn', name: 'bad', run: async () => { throw new Error('boom') } }
    const good: PreTurnRuntimeHook = { phase: 'preTurn', name: 'good', run: async () => { order.push('good') } }
    const pipeline = new RuntimeHookPipeline([bad, good], { onError: error => errors.push(error) })

    await pipeline.runPreTurn(makeContext())

    assert.deepEqual(order, ['good'])
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.phase, 'preTurn')
    assert.equal(errors[0]!.hookName, 'bad')
    assert.match(errors[0]!.message, /boom/)
  })

  it('only runs hooks for the requested phase', async () => {
    const order: string[] = []
    const pre: PreTurnRuntimeHook = { phase: 'preTurn', name: 'pre', run: async () => { order.push('pre') } }
    const postTool: PostToolRuntimeHook = { phase: 'postTool', name: 'postTool', run: async () => { order.push('postTool') } }
    const pipeline = new RuntimeHookPipeline([pre, postTool])

    await pipeline.runPreTurn(makeContext())

    assert.deepEqual(order, ['pre'])
  })

  it('updates snapshot when state-setting effects are used', async () => {
    const ctx = makeContext()
    const errors: RuntimeHookError[] = []
    const pipeline = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'sensorium-setter',
      run: runtime => {
        runtime.effects.setSensorium({ momentum: 0.1, pressure: 0.2, confidence: 0.3, complexity: 0.4, freshness: 0.5, stability: 0.6 })
        runtime.effects.setStrategy({ reasoningEffort: 'high', explorationBreadth: 0.9, commitThreshold: 0.8, shouldEscalate: true, thetaCycleInterval: 3 })
      },
    }, {
      phase: 'preTurn',
      name: 'reader',
      run: runtime => {
        assert.equal(runtime.snapshot.sensorium?.momentum, 0.1)
        assert.equal(runtime.snapshot.strategy?.reasoningEffort, 'high')
      },
    }], { onError: error => errors.push(error) })

    await pipeline.runPreTurn(ctx)

    assert.deepEqual(errors, [])
  })

  it('exposes typed effects for controlled hook-to-loop communication', async () => {
    const messages: string[] = []
    const thetaRequests: string[] = []
    const phases: Array<{ phase: string; detail?: { tool?: string; reason?: string; suggestion?: string } }> = []
    const ctx = createRuntimeHookContext({
      cwd: '/tmp/project',
      turn: 1,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
    season: null,
    }, {
      injectUserMessage: message => { messages.push(message) },
      requestThetaCheck: reason => { thetaRequests.push(reason) },
      emitPhaseChange: (phase, detail) => { phases.push({ phase, detail }) },
    })
    const hook: PreTurnRuntimeHook = {
      phase: 'preTurn',
      name: 'effects',
      run: async (runtime) => {
        runtime.effects.injectUserMessage('hello')
        runtime.effects.requestThetaCheck('elm')
        runtime.effects.emitPhaseChange('tianshu-encore', { reason: 'kick' })
      },
    }
    const pipeline = new RuntimeHookPipeline([hook])

    await pipeline.runPreTurn(ctx)

    assert.deepEqual(messages, ['hello'])
    assert.deepEqual(thetaRequests, ['elm'])
    assert.deepEqual(phases, [{ phase: 'tianshu-encore', detail: { reason: 'kick' } }])
  })
})
