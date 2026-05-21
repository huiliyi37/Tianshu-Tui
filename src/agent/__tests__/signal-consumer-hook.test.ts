import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createSignalConsumerRuntimeHook } from '../hooks/signal-consumer-hook.js'
import type { SensoriumInput, StrategyProfile } from '../sensorium.js'
import type { PheromoneRef } from '../sensorium.js'

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

function makeInput(overrides: Partial<SensoriumInput> = {}): SensoriumInput {
  return {
    predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 5 },
    pressureResult: { ratio: 0.2, tier: 0, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false },
    evidenceState: { filesModified: 0, verifiedCount: 0 },
    toolCallHistory: [],
    pheromones: [],
    doomLevel: 'none',
    gitChangeRate: 0,
    ...overrides,
  }
}

function makeDeadEnd(path: string, context?: string): PheromoneRef {
  return {
    path,
    signal: 'dead-end',
    strength: 0.9,
    depositedAt: 1,
    halfLife: 1000,
    ...(context ? { context } : {}),
  }
}

function runHook(options: {
  strategy?: StrategyProfile | null
  sensoriumInput?: SensoriumInput
  dedupe?: boolean
} = {}) {
  const messages: string[] = []
  const phases: Array<{ phase: string; reason?: string }> = []
  const ctx = createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: 1,
    recentToolHistory: [],
    sensorium: null,
    sensoriumInput: options.sensoriumInput ?? makeInput(),
    strategy: options.strategy === undefined ? makeStrategy() : options.strategy,
    vigor: null,
    season: null,
    gitChangeRate: 0,
  }, {
    injectUserMessage: message => { messages.push(message) },
    emitPhaseChange: (phase, detail) => { phases.push({ phase, reason: detail?.reason }) },
  })
  const hook = createSignalConsumerRuntimeHook({ dedupe: options.dedupe })
  return { hook, ctx, messages, phases }
}

describe('createSignalConsumerRuntimeHook', () => {
  it('injects wide search hint when exploration breadth is high', async () => {
    const { hook, ctx, messages } = runHook({
      strategy: makeStrategy({ explorationBreadth: 0.9 }),
    })

    await hook.run(ctx)

    assert.deepEqual(messages, ['<search-breadth mode="wide" />'])
  })

  it('emits cautious phase when commit threshold is high', async () => {
    const { hook, ctx, phases } = runHook({
      strategy: makeStrategy({ commitThreshold: 0.9 }),
    })

    await hook.run(ctx)

    assert.deepEqual(phases, [{ phase: 'cautious', reason: 'high commit threshold' }])
  })

  it('injects task decomposition hint when pressure monitor reports thrashing', async () => {
    const { hook, ctx, messages } = runHook({
      sensoriumInput: makeInput({
        pressureResult: {
          ratio: 0.9,
          tier: 3,
          shouldCompact: true,
          thrashing: true, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false,
          suggestion: 'task_decomposition',
        },
      }),
    })

    await hook.run(ctx)

    assert.equal(messages.length, 1)
    assert.match(messages[0]!, /任务过大/)
  })

  it('injects compressed file warnings for dead-end pheromones', async () => {
    const { hook, ctx, messages } = runHook({
      sensoriumInput: makeInput({
        pheromones: [makeDeadEnd('src/a.ts'), makeDeadEnd('src/a.ts'), makeDeadEnd('src/b.ts')],
      }),
    })

    await hook.run(ctx)

    assert.equal(messages.length, 1)
    assert.match(messages[0]!, /<file-warnings kind="dead-end" compressed="true">/)
    // Generic rule since these paths don't match specific patterns
    assert.match(messages[0]!, /\[generic\]/)
  })

  it('injects rule-based warnings for known dead-end patterns', async () => {
    const { hook, ctx, messages } = runHook({
      sensoriumInput: makeInput({
        pheromones: [
          makeDeadEnd('printenv API_KEY'),
          makeDeadEnd('npx tsx --test src/foo.test.ts'),
        ],
      }),
    })

    await hook.run(ctx)

    assert.equal(messages.length, 1)
    assert.match(messages[0]!, /<file-warnings kind="dead-end" compressed="true">/)
    assert.match(messages[0]!, /\[security\]/)
    assert.match(messages[0]!, /\[test-runner\]/)
  })

  it('deduplicates repeated signal emissions by default', async () => {
    const { hook, ctx, messages } = runHook({
      strategy: makeStrategy({ explorationBreadth: 0.9 }),
    })

    await hook.run(ctx)
    await hook.run(ctx)

    assert.deepEqual(messages, ['<search-breadth mode="wide" />'])
  })

  it('preserves dead-end context in generic recommendations', async () => {
    const { hook, ctx, messages } = runHook({
      sensoriumInput: makeInput({
        pheromones: [
          makeDeadEnd('bash-command', 'npm run build failed with TS2345: type mismatch'),
        ],
      }),
    })

    await hook.run(ctx)

    assert.equal(messages.length, 1)
    assert.match(messages[0]!, /<file-warnings/)
    assert.match(messages[0]!, /npm run build failed with TS2345/)
  })
})
