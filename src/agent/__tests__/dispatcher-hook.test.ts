import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createDispatcherHook } from '../hooks/dispatcher-hook.js'
import type { TaskContract } from '../../context/task-contract.js'
import type { Sensorium } from '../sensorium.js'
import type { AdvisoryBus, AdvisoryEntry } from '../advisory-bus.js'

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

function makeBus(): { bus: AdvisoryBus; entries: AdvisoryEntry[] } {
  const entries: AdvisoryEntry[] = []
  const bus = {
    submit: (entry: AdvisoryEntry) => { entries.push(entry) },
    submitAll: (es: AdvisoryEntry[]) => { entries.push(...es) },
    render: () => '',
    reset: () => { entries.length = 0 },
  } as unknown as AdvisoryBus
  return { bus, entries }
}

function runHook(options: {
  contract?: TaskContract | null
  sensorium?: Sensorium | null
  complexityThreshold?: number
}) {
  const phases: Array<{ phase: string; reason?: string; suggestion?: string }> = []
  const { bus, entries } = makeBus()

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
    getTaskContract: () => options.contract ?? undefined,
    getSensorium: () => options.sensorium ?? null,
    advisoryBus: bus,
    complexityThreshold: options.complexityThreshold,
  })

  return { hook, ctx, phases, entries }
}

describe('createDispatcherHook (delegation advisor)', () => {
  it('does nothing when no contract', async () => {
    const { hook, ctx, phases, entries } = runHook({})
    await hook.run(ctx)
    assert.equal(phases.length, 0)
    assert.equal(entries.length, 0)
  })

  it('does nothing when contract is not actionable', async () => {
    const { hook, ctx, phases, entries } = runHook({
      contract: makeContract({ isActionable: false }),
    })
    await hook.run(ctx)
    assert.equal(phases.length, 0)
    assert.equal(entries.length, 0)
  })

  it('does nothing when complexity below threshold', async () => {
    const { hook, ctx, phases, entries } = runHook({
      contract: makeContract(),
      sensorium: makeSensorium(0.1),
      complexityThreshold: 0.3,
    })
    await hook.run(ctx)
    assert.equal(phases.length, 0)
    assert.equal(entries.length, 0)
  })

  it('does nothing for single-domain tasks', async () => {
    const { hook, ctx, phases, entries } = runHook({
      contract: makeContract({ scope: { mentionedFiles: ['src/agent/loop.ts'] } }),
      sensorium: makeSensorium(0.5),
    })
    await hook.run(ctx)
    assert.equal(phases.length, 0)
    assert.equal(entries.length, 0)
  })

  it('advises delegate_batch for multi-domain tasks instead of acting', async () => {
    const { hook, ctx, phases, entries } = runHook({
      contract: makeContract(),
      sensorium: makeSensorium(0.5),
    })
    await hook.run(ctx)
    assert.ok(phases.some(p => p.phase === 'task-decomposed'))
    assert.equal(entries.length, 1)
    const entry = entries[0]!
    assert.equal(entry.category, 'delegation')
    assert.ok(entry.content.includes('delegate_batch'))
    assert.ok(entry.content.includes('backend'))
    assert.ok(entry.content.includes('frontend'))
  })

  it('surfaces dependency arrows in the advisory', async () => {
    const { hook, ctx, entries } = runHook({
      contract: makeContract({
        scope: { mentionedFiles: ['src/agent/auth.ts', 'src/agent/__tests__/auth.test.ts'] },
      }),
      sensorium: makeSensorium(0.5),
    })
    await hook.run(ctx)
    assert.equal(entries.length, 1)
    // tests task depends on the backend source task → arrow notation
    assert.ok(entries[0]!.content.includes('tests←[backend]'))
  })

  it('only advises once per contract', async () => {
    const { hook, ctx, entries } = runHook({
      contract: makeContract(),
      sensorium: makeSensorium(0.5),
    })
    await hook.run(ctx)
    await hook.run(ctx)
    // Second run is a no-op (cooldown + per-contract dedup)
    assert.equal(entries.length, 1)
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
