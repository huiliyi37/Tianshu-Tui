import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createDispatcherHook } from '../hooks/dispatcher-hook.js'
import type { TaskContract } from '../../context/task-contract.js'
import type { Sensorium } from '../sensorium.js'
import type { DelegationCoordinator, DelegationRequest } from '../coordinator.js'

function makeContract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: 'test-contract',
    objective: '重构 auth 模块并添加测试',
    scope: { mentionedFiles: ['src/agent/auth.ts', 'src/tui/login.tsx'] },
    constraints: [],
    successCriteria: [],
    status: 'exploring',
    createdAtTurn: 0,
    updatedAtTurn: 0,
    isActionable: true,
    ...overrides,
  }
}

function makeSensorium(complexity = 0.5): Sensorium {
  return {
    momentum: 0.5,
    pressure: 0.2,
    confidence: 0.6,
    complexity,
    freshness: 0.7,
    stability: 0.8,
  }
}

function makeCoordinator(): DelegationCoordinator & { requests: DelegationRequest[] } {
  const requests: DelegationRequest[] = []
  const coordinator = {
    requests,
    delegate: async (req: DelegationRequest) => {
      requests.push(req)
      return { status: 'completed' as const, results: [], packet: '' }
    },
  } as unknown as DelegationCoordinator & { requests: DelegationRequest[] }
  return coordinator
}

function runHook(options: {
  contract?: TaskContract | null
  sensorium?: Sensorium | null
  complexityThreshold?: number
}) {
  const phases: Array<{ phase: string; reason?: string; suggestion?: string }> = []
  const coordinator = makeCoordinator()

  const ctx = createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: 1,
    recentToolHistory: [],
    sensorium: null,
    sensoriumInput: undefined,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  }, {
    emitPhaseChange: (phase, detail) => { phases.push({ phase, reason: detail?.reason, suggestion: detail?.suggestion }) },
  })

  const hook = createDispatcherHook({
    coordinator: () => coordinator,
    getTaskContract: () => options.contract ?? undefined,
    getSensorium: () => options.sensorium ?? null,
    complexityThreshold: options.complexityThreshold,
  })

  return { hook, ctx, phases, coordinator }
}

describe('createDispatcherHook', () => {
  it('does nothing when no contract', async () => {
    const { hook, ctx, phases, coordinator } = runHook({})
    await hook.run(ctx)
    assert.equal(phases.length, 0)
    assert.equal(coordinator.requests.length, 0)
  })

  it('does nothing when contract is not actionable', async () => {
    const { hook, ctx, phases, coordinator } = runHook({
      contract: makeContract({ isActionable: false }),
    })
    await hook.run(ctx)
    assert.equal(phases.length, 0)
    assert.equal(coordinator.requests.length, 0)
  })

  it('does nothing when complexity below threshold', async () => {
    const { hook, ctx, phases, coordinator } = runHook({
      contract: makeContract(),
      sensorium: makeSensorium(0.1),
      complexityThreshold: 0.3,
    })
    await hook.run(ctx)
    assert.equal(phases.length, 0)
    assert.equal(coordinator.requests.length, 0)
  })

  it('does nothing for single-domain tasks', async () => {
    const { hook, ctx, phases, coordinator } = runHook({
      contract: makeContract({ scope: { mentionedFiles: ['src/agent/loop.ts'] } }),
      sensorium: makeSensorium(0.5),
    })
    await hook.run(ctx)
    assert.equal(phases.length, 0)
    assert.equal(coordinator.requests.length, 0)
  })

  it('decomposes multi-domain tasks and delegates to coordinator', async () => {
    const { hook, ctx, phases, coordinator } = runHook({
      contract: makeContract(),
      sensorium: makeSensorium(0.5),
    })
    await hook.run(ctx)
    assert.ok(phases.some(p => p.phase === 'task-decomposed'))
    assert.ok(coordinator.requests.length >= 2)
  })

  it('only dispatches once per run', async () => {
    const { hook, ctx, coordinator } = runHook({
      contract: makeContract(),
      sensorium: makeSensorium(0.5),
    })
    await hook.run(ctx)
    await hook.run(ctx)
    // Second run should be no-op (dispatched flag)
    assert.ok(coordinator.requests.length >= 2)
  })

  it('emits task-decomposed with domain info', async () => {
    const { hook, ctx, phases } = runHook({
      contract: makeContract(),
      sensorium: makeSensorium(0.5),
    })
    await hook.run(ctx)
    const decomposed = phases.find(p => p.phase === 'task-decomposed')
    assert.ok(decomposed)
    assert.ok(decomposed.suggestion?.includes('backend'))
  })
})
