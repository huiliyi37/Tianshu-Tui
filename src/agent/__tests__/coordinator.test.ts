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

function sortedReadOnlyToolNames(): string[] {
  return [...READ_ONLY_WORKER_TOOLS].sort()
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
    assert.deepEqual(seenToolNames[0], sortedReadOnlyToolNames())
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

  it('keeps failed batch workers visible in aggregated results', async () => {
    let calls = 0
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
        calls++
        if (calls === 1) throw new Error('worker transport failed')
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
        parentTurnId: 'turn_b1',
        objective: 'Search for routing seams in main module.',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/main.tsx'] },
      },
      {
        parentTurnId: 'turn_b1',
        objective: 'Review coordinator risk patterns across the delegation module boundary.',
        kind: 'review',
        profile: 'reviewer',
        scope: { files: ['src/agent/coordinator.ts', 'src/agent/work-order.ts'] },
      },
    ])

    assert.equal(run.status, 'completed')
    assert.equal(run.results.length, 2)
    assert.equal(run.results.filter(r => r.status === 'blocked').length, 1)
    assert.ok(run.packet.includes('worker transport failed'))
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

  it('routes to different model based on task type when routing configured', async () => {
    const selectedModels: string[] = []
    const cheapCards: ModelCapabilityCard[] = [
      { model: 'gpt-5.5', toolUseReliability: 0.9, jsonStability: 0.9, editSuccessRate: 0.9, testRepairRate: 0.8, contextWindow: 1_000_000, cacheEconomics: 'medium', recommendedTasks: [] },
      { model: 'MiniMax-M2.7', toolUseReliability: 0.7, jsonStability: 0.7, editSuccessRate: 0.6, testRepairRate: 0.5, contextWindow: 204_800, cacheEconomics: 'weak', recommendedTasks: [] },
    ]

    const runtimeFactory: WorkerRuntimeFactory = (order, card, workerRegistry) => {
      selectedModels.push(card.model)
      return {
        order,
        client: {} as ApiClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }
    }

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cheapCards,
      maxWorkers: 3,
      runtimeFactory,
      routing: {
        profiles: {
          capable: { provider: 'codex', model: 'gpt-5.5' },
          cheap: { provider: 'minimax', model: 'MiniMax-M2.7' },
        },
        routing: {
          repo_summarization: 'cheap',
          code_edit: 'capable',
        },
      },
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    // code_search routes to 'cheap' → MiniMax-M2.7
    await coordinator.delegate({
      parentTurnId: 'turn_r1',
      objective: 'Search for all imports of the coordinator module across the codebase.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/coordinator.ts'] },
    })

    assert.equal(selectedModels[0], 'MiniMax-M2.7')
  })

  it('falls back to recommendModelForTask when routed provider lacks credentials', async () => {
    const selectedModels: string[] = []
    const previous = process.env.MISSING_WORKER_KEY
    delete process.env.MISSING_WORKER_KEY

    try {
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: [
          ...cards,
          { model: 'unavailable-routed', toolUseReliability: 0.9, jsonStability: 0.9, editSuccessRate: 0.9, testRepairRate: 0.8, contextWindow: 1_000_000, cacheEconomics: 'medium', recommendedTasks: [] },
        ],
        maxWorkers: 2,
        runtimeFactory: (order, card, workerRegistry) => {
          selectedModels.push(card.model)
          return {
            order,
            client: {} as ApiClient,
            promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
            toolRegistry: workerRegistry,
            cwd: '/repo',
            maxTurns: 2,
            contextWindow: card.contextWindow,
            compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
          }
        },
        routing: {
          providers: {
            unavailable: {
              name: 'unavailable',
              apiKeyEnv: 'MISSING_WORKER_KEY',
              baseUrl: 'https://example.com/v1',
              protocol: 'openai',
              capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none' },
              thinking: 'enabled',
              maxTokens: 4096,
              models: [{ id: 'unavailable-routed', contextWindow: 128_000, maxTokens: 4096 }],
              unsupported: [],
            },
          },
          profiles: { cheap: { provider: 'unavailable', model: 'unavailable-routed' } },
          routing: { repo_summarization: 'cheap' },
        },
        runWorker: async config => ({
          result: resultFor(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      })

      await coordinator.delegate({
        parentTurnId: 'turn_r3',
        objective: 'Research the documentation structure and key modules for onboarding.',
        kind: 'doc_research',
        profile: 'code_scout',
        scope: {},
      })

      assert.equal(selectedModels[0], 'large-cache')
    } finally {
      if (previous === undefined) delete process.env.MISSING_WORKER_KEY
      else process.env.MISSING_WORKER_KEY = previous
    }
  })

  it('falls back to recommendModelForTask when routing has no match', async () => {
    const selectedModels: string[] = []

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        selectedModels.push(card.model)
        return {
          order,
          client: {} as ApiClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      routing: {
        profiles: { cheap: { provider: 'minimax', model: 'MiniMax-M2.7' } },
        routing: { repo_summarization: 'cheap' },
      },
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    // doc_research maps to 'repo_summarization' capability task, which has no routing entry
    await coordinator.delegate({
      parentTurnId: 'turn_r2',
      objective: 'Research the documentation structure and key modules for onboarding.',
      kind: 'doc_research',
      profile: 'code_scout',
      scope: {},
    })

    // recommendModelForTask('repo_summarization') picks 'large-cache' (strong cacheEconomics + 1M context)
    assert.equal(selectedModels[0], 'large-cache')
  })
})
