import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../api/client.js'
import { PromptEngine } from '../../prompt/engine.js'
import { filterToolRegistry, ToolRegistry } from '../../tools/registry.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import {
  DelegationCoordinator,
  shouldDelegateObjective,
  type WorkerRuntimeFactory,
} from '../coordinator.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'

function fakeTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry() {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  registry.register(fakeTool('write_file'))
  return registry
}

const cards: ModelCapabilityCard[] = [
  {
    model: 'fast-json',
    toolUseReliability: 0.6,
    jsonStability: 0.95,
    editSuccessRate: 0.4,
    testRepairRate: 0.5,
    contextWindow: 128_000,
    cacheEconomics: 'medium',
    recommendedTasks: ['plan'],
  },
  {
    model: 'large-cache',
    toolUseReliability: 0.8,
    jsonStability: 0.8,
    editSuccessRate: 0.7,
    testRepairRate: 0.6,
    contextWindow: 1_000_000,
    cacheEconomics: 'strong',
    recommendedTasks: ['code_search'],
  },
]

function resultFor(id: string): WorkerResult {
  return {
    workOrderId: id,
    status: 'passed',
    summary: `completed ${id}`,
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
  }
}

describe('DelegationCoordinator', () => {
  it('uses a budget gate for trivial objectives', () => {
    assert.equal(shouldDelegateObjective('tiny', {}), false)
    assert.equal(shouldDelegateObjective('compare routing seams across worker session and coordinator modules', {}), true)
    assert.equal(shouldDelegateObjective('inspect files', { files: ['a.ts', 'b.ts'] }), true)
  })

  it('selects a model through recommendModelForTask and uses a read-only registry', async () => {
    const selectedModels: string[] = []
    const seenToolNames: string[][] = []
    const runtimeFactory: WorkerRuntimeFactory = (order, card, workerRegistry) => {
      selectedModels.push(card.model)
      seenToolNames.push(workerRegistry.getDefinitions().map(t => t.name))
      return {
        order,
        client: {} as ApiClient,
        promptEngine: new PromptEngine({
          model: card.model,
          maxTokens: 1024,
          staticCtx: { tools: workerRegistry.getDefinitions() },
          volatileCtx: { cwd: '/repo' },
        }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }
    }

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory,
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_1',
      objective: 'Find model routing and tool registry seams across the current runtime.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/main.tsx', 'src/tools/registry.ts'] },
    })

    assert.equal(run.status, 'completed')
    assert.equal(run.results.length, 1)
    assert.deepEqual(selectedModels, ['large-cache'])
    assert.deepEqual(seenToolNames[0], ['diff', 'glob', 'grep', 'read_file'])
  })

  it('returns skipped when the objective does not pass the budget gate', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: filterToolRegistry(makeRegistry(), READ_ONLY_WORKER_TOOLS),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as ApiClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_1',
      objective: 'tiny',
      kind: 'code_search',
      profile: 'code_scout',
      scope: {},
    })

    assert.equal(run.status, 'skipped')
    assert.equal(run.results.length, 0)
  })

  it('delegates multiple work orders concurrently and aggregates results', async () => {
    const completedOrders: string[] = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as ApiClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async config => {
        completedOrders.push(config.order.id)
        return {
          result: resultFor(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    const run = await coordinator.delegateBatch([
      {
        parentTurnId: 'turn_1',
        objective: 'Search for routing seams in main module.',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/main.tsx'] },
      },
      {
        parentTurnId: 'turn_1',
        objective: 'Review coordinator risk patterns across the delegation module boundary.',
        kind: 'review',
        profile: 'reviewer',
        scope: { files: ['src/agent/coordinator.ts', 'src/agent/work-order.ts'] },
      },
    ])

    assert.equal(run.status, 'completed')
    assert.equal(run.results.length, 2)
    assert.ok(run.results.every(r => r.status === 'passed'))
  })

  it('exposes coordinator state with lifecycle events', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as ApiClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    await coordinator.delegate({
      parentTurnId: 'turn_1',
      objective: 'Search for routing seams in main module.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/main.tsx', 'src/agent/loop.ts'] },
    })

    const state = coordinator.getState()
    assert.ok(state.getSummary().queued > 0)
    assert.ok(state.getSummary().passed > 0)
  })

  it('blocks single worker result with changed files and unverified evidence', async () => {
    const unverifiedResult: WorkerResult = {
      workOrderId: 'wo_unverified',
      status: 'passed',
      summary: 'Changed files without verification',
      findings: [],
      artifacts: [],
      changedFiles: ['src/agent/loop.ts', 'src/agent/coordinator.ts'],
      risks: [],
      nextActions: [],
      evidenceStatus: 'unverified',
    }

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as ApiClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async config => ({
        result: { ...unverifiedResult, workOrderId: config.order.id },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_ev1',
      objective: 'Search for evidence gate seams across coordinator and aggregation modules.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/coordinator.ts', 'src/agent/aggregation.ts'] },
    })

    assert.equal(run.status, 'completed')
    assert.equal(run.results.length, 1)
    assert.equal(run.results[0]!.status, 'blocked')
    assert.ok(run.results[0]!.risks.some(r => r.includes('unverified')))
  })
})
