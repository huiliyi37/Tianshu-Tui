import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamClient } from '../../api/stream-client.js'
import { PromptEngine } from '../../prompt/engine.js'
import { filterToolRegistry, ToolRegistry } from '../../tools/registry.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import {
  DelegationCoordinator,
  shouldDelegateObjective,
  type WorkerRuntimeFactory,
} from '../coordinator.js'
import { READ_ONLY_WORKER_TOOLS, WRITE_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
import { CollaborationProtocol } from '../collaboration-protocol.js'
import { profileRegistry } from '../profile-registry.js'
import { ProviderHealthTracker } from '../provider-health.js'

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
  for (const name of ['edit_file', 'write_file', 'bash', 'run_tests']) registry.register(fakeTool(name))
  // Mirror the production base registry: register every tool any built-in profile
  // can allowlist (file_info / semantic_search / web_search / web_fetch / hash_edit /
  // apply_patch / git / delegate_* / lsp_* …) so filterToolRegistry (coordinator)
  // never throws "Cannot allowlist unknown tool" on a stale hand-maintained set.
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) registry.register(fakeTool(tool))
  }
  return registry
}

function sortedReadOnlyToolNames(): string[] {
  // ProfileRegistry provides tools for readonly profiles — includes read_section, repo_graph
  return [...READ_ONLY_WORKER_TOOLS, 'read_section', 'repo_graph'].sort()
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

function modelTierRows(tier: 'cheap' | 'balanced' | 'strong', model: string, reward: number, count = 35) {
  return {
    shadows: Array.from({ length: count }, (_, i) => ({
      kind: `model_tier_shadow:s-tier:team:T${i}:${i}`,
      json: JSON.stringify({
        schemaVersion: 1,
        sessionId: 's-tier',
        workOrderId: `team:T${i}`,
        profile: 'code_scout',
        kind: 'code_search',
        recommendedTier: tier,
        actualModel: model,
        actualTier: tier,
        matched: true,
        reason: 'history',
        timestamp: i,
      }),
    })),
    rewards: Array.from({ length: count }, (_, i) => ({
      kind: `reward_closure:team_wave:s-tier:${i}:x`,
      json: JSON.stringify({
        schemaVersion: 1,
        id: `r:${i}`,
        sourceKind: 'team_wave',
        sourceKey: `team_wave:${i}`,
        sessionId: 's-tier',
        reward,
        components: { workerModel: model },
        timestamp: 100 + i,
      }),
    })),
  }
}

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

  it('counts CJK characters so Chinese objectives are not silently skipped', () => {
    // Whitespace word-count reads a spaceless Chinese objective as ~1 word and
    // would wrongly skip dispatch. A substantive Chinese objective must pass.
    assert.equal(shouldDelegateObjective('修复并发工具调用导致的参数污染问题', {}), true)
    // The patcher's Chinese instruction prefix alone is substantive enough.
    assert.equal(
      shouldDelegateObjective('你是天梁执行者。只执行本 task，不扩展范围，不重写计划。\n\nModify foo', {}),
      true,
    )
    // A trivial Chinese fragment (< 8 CJK chars, no files/symbols) is still gated.
    assert.equal(shouldDelegateObjective('改一下', {}), false)
  })

  it('degrades gracefully when a profile allowlists a tool absent from the base registry', async () => {
    // Reproduces the "Cannot allowlist unknown tool" terminal failure: a profile
    // references a tool that isn't registered this session (gated/MCP/host-trimmed).
    // The worker must still run with the remaining tools instead of crashing.
    const readOnly = new Set<string>(READ_ONLY_WORKER_TOOLS)
    const profileTools = [...profileRegistry.get('code_scout')!.allowedTools]
    // The omitted tool must NOT be a READ_ONLY tool, otherwise the read-only loop
    // below re-registers it and it would not actually be missing.
    const omittedCandidate = profileTools.filter(t => !readOnly.has(t)).pop()
    assert.ok(omittedCandidate, 'code_scout must allowlist at least one non-read-only tool to omit')
    const omitted: string = omittedCandidate

    const partialRegistry = new ToolRegistry()
    for (const name of READ_ONLY_WORKER_TOOLS) partialRegistry.register(fakeTool(name))
    for (const pname of profileRegistry.getProfileNames()) {
      for (const tool of profileRegistry.get(pname)!.allowedTools) {
        if (tool === omitted) continue
        if (!partialRegistry.has(tool)) partialRegistry.register(fakeTool(tool))
      }
    }

    let workerRan = false
    let capturedTools: string[] = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: partialRegistry,
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        capturedTools = workerRegistry.getAll().map(t => t.definition.name)
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async config => {
        workerRan = true
        return {
          result: resultFor(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    await assert.doesNotReject(
      coordinator.delegate({
        parentTurnId: 'turn-missing-tool',
        objective: 'Inspect the coordinator tool filtering path and report graceful degradation behavior',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/agent/coordinator.ts', 'src/tools/registry.ts'] },
      }),
    )

    assert.equal(workerRan, true, 'worker must still run despite the missing tool')
    assert.ok(!capturedTools.includes(omitted), `omitted tool ${omitted} must be dropped, not crash`)
    assert.ok(capturedTools.length > 0, 'remaining allowlisted tools must survive')
  })

  it('propagates reviewDepth from delegation request into worker runtime config', async () => {
    let orderDepth: number | undefined
    let configDepth: number | undefined
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        orderDepth = order.reviewDepth
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async config => {
        configDepth = config.reviewDepth
        return {
          result: resultFor(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    await coordinator.delegate({
      parentTurnId: 'turn-review-depth',
      objective: 'Verify structural review depth propagation across worker runtime config',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/coordinator.ts', 'src/agent/deliver-task.ts'] },
      reviewDepth: 1,
    })

    assert.equal(orderDepth, 1)
    assert.equal(configDepth, 1)
  })

  it('clamps worker maxTurns to the work order budget (R3.1 budget enforcement)', async () => {
    let capturedMaxTurns: number | undefined
    let budgetMaxTurns: number | undefined
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        budgetMaxTurns = order.budget.maxTurns
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          // Deliberately huge generic default — the per-profile budget must win.
          maxTurns: 99,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async config => {
        capturedMaxTurns = config.maxTurns
        return {
          result: resultFor(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    await coordinator.delegate({
      parentTurnId: 'turn-budget',
      objective: 'Verify worker turn budget is enforced against runtime default',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/coordinator.ts', 'src/agent/worker-session.ts'] },
    })

    assert.equal(typeof budgetMaxTurns, 'number')
    assert.ok(budgetMaxTurns! < 99, 'budget should be tighter than the runtime default')
    assert.equal(capturedMaxTurns, budgetMaxTurns, 'worker must run within the work order budget, not the runtime default')
  })

  it('flows parentApprovalMode down to the worker session config (downward trust delegation)', async () => {
    let capturedMode: string | undefined
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      parentApprovalMode: 'dangerously-skip-permissions',
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 40,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async config => {
        capturedMode = config.parentApprovalMode
        return {
          result: resultFor(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    await coordinator.delegate({
      parentTurnId: 'turn-approval-flow',
      objective: 'Verify parent approval mode flows into the worker session config',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/coordinator.ts'] },
    })

    assert.equal(capturedMode, 'dangerously-skip-permissions')
  })

  it('routes patcher profile through injected hands runner seam', async () => {
    let handsCalled = false
    let workerCalled = false
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async config => {
        workerCalled = true
        assert.notEqual(config.cwd, '/repo')
        assert.ok(config.cwd.includes('rivet-wt-'), `hands worker cwd should be isolated worktree: ${config.cwd}`)
        assert.equal(config.order.objective, 'Patch multiple files safely inside an isolated worker worktree')
        return {
          result: resultFor(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
      runHands: async config => {
        handsCalled = true
        const callbacks = { onTextDelta: () => {}, onThinkingDelta: () => {}, onToolUse: () => {}, onToolResult: () => {}, onTurnComplete: () => {}, onError: () => {}, onAbort: () => {}, onApprovalRequired: async () => false }
        await config.runAgent('worker prompt', callbacks, '/tmp/rivet-wt-test')
        return {
          result: {
            workOrderId: config.order.id,
            status: 'passed',
            summary: 'hands completed in isolated worktree',
            findings: [],
            artifacts: [{ kind: 'diff', title: 'Patch: src/a.ts', content: 'diff --git a/src/a.ts b/src/a.ts' }],
            changedFiles: ['src/a.ts'],
            risks: [],
            nextActions: [],
            evidenceStatus: 'unverified',
          },
          usage: {},
        }
      },
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_hands_1',
      objective: 'Patch multiple files safely inside an isolated worker worktree',
      kind: 'patch_proposal',
      profile: 'patcher',
      scope: { files: ['src/a.ts', 'src/b.ts'] },
    })

    assert.equal(handsCalled, true)
    assert.equal(workerCalled, true)
    assert.equal(run.status, 'completed')
    assert.equal(run.results[0]?.artifacts[0]?.kind, 'diff')
  })

  it('selects a model through recommendModelForTask and uses a read-only registry', async () => {
    const selectedModels: string[] = []
    const seenToolNames: string[][] = []
    const runtimeFactory: WorkerRuntimeFactory = (order, card, workerRegistry) => {
      selectedModels.push(card.model)
      seenToolNames.push(workerRegistry.getDefinitions().map(t => t.name))
      return {
        order,
        client: {} as StreamClient,
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
    assert.deepEqual(seenToolNames[0], [...profileRegistry.get('code_scout')!.allowedTools].sort())
  })

  it('returns skipped when the objective does not pass the budget gate', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: filterToolRegistry(makeRegistry(), READ_ONLY_WORKER_TOOLS),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
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
        client: {} as StreamClient,
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

  it('A3: a dependent of a failed worker is reported as blocked, never silently dropped', async () => {
    const ran: string[] = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      // A hard dispatch fault (factory throw) propagates out of delegateOrder and
      // is caught as a worker failure → queue.markFailed. The upstream id then
      // never enters completedIds, so its dependent can never be dequeued.
      runtimeFactory: (order, card, workerRegistry) => {
        if (order.id === 'team:T1') throw new Error('factory boom')
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async config => {
        ran.push(config.order.id)
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
        parentTurnId: 'turn_meta:team:T1',
        objective: 'Scout the routing seams in the main module before review.',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/main.tsx'] },
      },
      {
        parentTurnId: 'turn_meta:team:T2',
        objective: 'Review the coordinator risk patterns that the scout surfaces.',
        kind: 'review',
        profile: 'reviewer',
        scope: { files: ['src/agent/coordinator.ts'] },
        dependencies: ['team:T1'],
      },
    ])

    // Every order must be accounted for — the dependent is NOT lost.
    assert.equal(run.results.length, 2)
    const t1 = run.results.find(r => r.workOrderId === 'team:T1')!
    const t2 = run.results.find(r => r.workOrderId === 'team:T2')!
    assert.equal(t1.status, 'blocked', 'failed upstream worker is blocked')
    assert.equal(t2.status, 'blocked', 'dependent is reported blocked, not dropped')
    assert.match(t2.summary, /dependency failed: team:T1/)
    // The dependent must never have actually run on the broken foundation.
    assert.ok(!ran.includes('team:T2'), 'dependent worker was not executed')
  })

  it('returns selected model metadata for each runnable batch work order', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
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

    const run = await coordinator.delegateBatch([
      {
        parentTurnId: 'turn_meta:team:T1',
        objective: 'Search for routing seams in main module.',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/main.tsx'] },
      },
      {
        parentTurnId: 'turn_meta:team:T2',
        objective: 'Review coordinator risk patterns across delegation and aggregation boundaries.',
        kind: 'review',
        profile: 'reviewer',
        scope: { files: ['src/agent/coordinator.ts', 'src/agent/aggregation.ts'] },
      },
    ])

    assert.equal(run.status, 'completed')
    assert.deepEqual(run.workerModels?.sort((a, b) => a.workOrderId.localeCompare(b.workOrderId)), [
      { workOrderId: 'team:T1', model: 'large-cache' },
      { workOrderId: 'team:T2', model: 'large-cache' },
    ])
  })

  it('records model tier shadow without changing selected worker model', async () => {
    const saved: Array<{ kind: string; json: string }> = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
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
      modelTierShadowStore: { saveBanditState: (kind, json) => { saved.push({ kind, json }) } },
      sessionId: 's-tier',
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn-tier',
      objective: 'Review coordinator false-green risk with strong authority floor.',
      kind: 'review',
      profile: 'reviewer',
      scope: { files: ['src/agent/coordinator.ts', 'src/agent/aggregation.ts'] },
      authority: 'tianquan',
    })

    // reviewer has tierLock:'cheap' → preferredTier='cheap' → no cheap cards in set
    // → fallback to all cards → recommendModelForTask picks large-cache
    assert.equal(run.selectedModel, 'large-cache')
    assert.equal(saved.length, 3)
    assert.ok(saved.some(row => row.kind.startsWith('gated_influence_audit:model_tier_bandit:')))
    const audit = JSON.parse(saved.find(row => row.kind.startsWith('gated_influence_audit:model_tier_bandit:'))!.json)
    assert.equal(audit.applied, false)
    assert.equal(audit.source, 'model_tier_bandit')
    const event = JSON.parse(saved.find(row => row.kind.startsWith('model_tier_shadow:'))!.json)
    assert.equal(event.recommendedTier, 'cheap')
    assert.equal(event.actualModel, 'large-cache')
    assert.equal(event.actualTier, 'strong')
    assert.equal(event.matched, false)
    assert.equal(run.modelTierShadows?.[0]?.recommendedTier, 'cheap')
    assert.equal(run.modelTierGatedDecisions?.[0]?.applied, false)
    assert.equal(run.modelTierGatedDecisions?.[0]?.selectedModel, 'large-cache')
  })

  it('applies gated tier influence only when the feature flag is enabled', async () => {
    const history = modelTierRows('cheap', 'cheap-flash', 0.9)
    const selectedModels: string[] = []
    const saved: Array<{ kind: string; json: string }> = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: [
        ...cards,
        { model: 'cheap-flash', toolUseReliability: 0.45, jsonStability: 0.45, editSuccessRate: 0.45, testRepairRate: 0.45, contextWindow: 128_000, cacheEconomics: 'weak', recommendedTasks: [] },
      ],
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        selectedModels.push(card.model)
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
      modelTierShadowStore: {
        saveBanditState: (kind, json) => { saved.push({ kind, json }) },
        loadBanditStatesByPrefix: prefix => prefix === 'model_tier_shadow:' ? history.shadows : prefix === 'reward_closure:team_wave:' ? history.rewards : [],
      },
      modelTierBanditEnabled: true,
      sessionId: 's-tier',
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn-tier-apply',
      objective: 'Assess low risk documentation changes and exercise gated cheap tier selection.',
      kind: 'review',
      profile: 'reviewer',
      riskTier: 'low',
      scope: { files: ['docs/a.md', 'docs/b.md', 'docs/c.md'] },
      authority: 'tianliang',
    })

    // tierLock:'cheap' forces ruleTier=cheap; bandit also recommends cheap →
    // baseline=candidate (same arm), margin=0 → gate closed (reward_margin)
    assert.equal(run.selectedModel, 'cheap-flash')
    assert.deepEqual(selectedModels, ['cheap-flash'])
    assert.equal(run.modelTierGatedDecisions?.[0]?.applied, false)
    assert.equal(run.modelTierGatedDecisions?.[0]?.candidateTier, 'cheap')
    assert.equal(run.modelTierGatedDecisions?.[0]?.selectedTier, 'cheap')
    assert.ok(saved.some(row => row.kind.startsWith('model_tier_gated_decision:')))
    const audit = JSON.parse(saved.find(row => row.kind.startsWith('gated_influence_audit:model_tier_bandit:'))!.json)
    assert.equal(audit.applied, false)
    assert.equal(audit.evidenceWindow.selectedTier, 'cheap')
  })

  it('does not consume historical tier evidence when the feature flag is disabled', async () => {
    const history = modelTierRows('cheap', 'cheap-flash', 0.9)
    const selectedModels: string[] = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: [
        ...cards,
        { model: 'cheap-flash', toolUseReliability: 0.45, jsonStability: 0.45, editSuccessRate: 0.45, testRepairRate: 0.45, contextWindow: 128_000, cacheEconomics: 'weak', recommendedTasks: [] },
      ],
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        selectedModels.push(card.model)
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], errors: [], toolResults: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
      modelTierShadowStore: {
        saveBanditState: () => {},
        loadBanditStatesByPrefix: prefix => prefix === 'model_tier_shadow:' ? history.shadows : prefix === 'reward_closure:team_wave:' ? history.rewards : [],
      },
      sessionId: 's-tier',
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn-tier-shadow-only',
      objective: 'Assess low risk documentation while model tier bandit remains shadow-only.',
      kind: 'review',
      profile: 'reviewer',
      riskTier: 'low',
      scope: { files: ['docs/a.md', 'docs/b.md', 'docs/c.md'] },
      authority: 'tianliang',
    })

    // reviewer tierLock:'cheap' → recommendedTier='cheap' → selects cheap-flash even when bandit disabled
    // tierLock=cheap matches bandit cheap → margin=0 → gateOpen=false
    assert.equal(run.selectedModel, 'cheap-flash')
    assert.deepEqual(selectedModels, ['cheap-flash'])
    assert.equal(run.modelTierGatedDecisions?.[0]?.gateOpen, false)
    assert.equal(run.modelTierGatedDecisions?.[0]?.applied, false)
  })

  it('scope-health history vetoes gated tier influence even with sufficient reward evidence', async () => {
    const history = modelTierRows('cheap', 'cheap-flash', 0.9)
    const selectedModels: string[] = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: [
        ...cards,
        { model: 'cheap-flash', toolUseReliability: 0.45, jsonStability: 0.45, editSuccessRate: 0.45, testRepairRate: 0.45, contextWindow: 128_000, cacheEconomics: 'weak', recommendedTasks: [] },
      ],
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        selectedModels.push(card.model)
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
      modelTierShadowStore: {
        saveBanditState: () => {},
        loadBanditStatesByPrefix: prefix => {
          if (prefix === 'model_tier_shadow:') return history.shadows
          if (prefix === 'reward_closure:team_wave:') return history.rewards
          if (prefix === 'team_scope_health:') return [{
            kind: 'team_scope_health:obj:s-tier:team_wave:1:x',
            json: JSON.stringify({ schemaVersion: 1, severity: 'high' }),
          }]
          return []
        },
      },
      modelTierBanditEnabled: true,
      sessionId: 's-tier',
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn-tier-scope-veto',
      objective: 'Assess low risk documentation with historical high scope leak veto.',
      kind: 'review',
      profile: 'reviewer',
      riskTier: 'low',
      scope: { files: ['docs/a.md', 'docs/b.md', 'docs/c.md'] },
      authority: 'tianliang',
    })

    // reviewer tierLock:'cheap' → tierRecommendation='cheap' even when gate vetoes
    // tierLock=cheap matches bandit cheap → margin=0 → gate closed on reward_margin (before scope-health)
    assert.equal(run.selectedModel, 'cheap-flash')
    assert.deepEqual(selectedModels, ['cheap-flash'])
    assert.equal(run.modelTierGatedDecisions?.[0]?.applied, false)
    assert.match(run.modelTierGatedDecisions?.[0]?.reason ?? '', /reward margin|scope-health/)
  })

  it('hardFloor prevents verifier downgrade despite strong cheap reward history', async () => {
    const history = modelTierRows('cheap', 'cheap-flash', 0.9)
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: [
        ...cards,
        { model: 'cheap-flash', toolUseReliability: 0.45, jsonStability: 0.45, editSuccessRate: 0.45, testRepairRate: 0.45, contextWindow: 128_000, cacheEconomics: 'weak', recommendedTasks: [] },
      ],
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
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
      modelTierShadowStore: {
        saveBanditState: () => {},
        loadBanditStatesByPrefix: prefix => prefix === 'model_tier_shadow:' ? history.shadows : prefix === 'reward_closure:team_wave:' ? history.rewards : [],
      },
      modelTierBanditEnabled: true,
      sessionId: 's-tier',
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn-tier-hardfloor',
      objective: 'Adversarially verify a failing test path where strong tier hard floor must hold.',
      kind: 'verify',
      profile: 'adversarial_verifier',
      authority: 'tianquan',
      scope: { files: ['src/agent/coordinator.ts', 'src/agent/__tests__/coordinator.test.ts'] },
    })

    // adversarial_verifier has tierLock:'cheap' — margin=0 (rule=bandit=cheap)
    // → gate closed on reward_margin → applied=false → falls back to tierRecommendation='cheap' → cheap-flash
    assert.equal(run.selectedModel, 'cheap-flash')
    assert.equal(run.modelTierGatedDecisions?.[0]?.applied, false)
    assert.match(run.modelTierGatedDecisions?.[0]?.reason ?? '', /reward margin/)
  })

  it('keeps failed batch workers visible in aggregated results', async () => {
    let calls = 0
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async config => {
        calls++
        // First worker (code_scout) always fails; reviewer succeeds.
        // code_scout gets retried via exponential backoff but keeps failing.
        if (config.order.profile === 'code_scout') throw new Error('worker transport failed')
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
        client: {} as StreamClient,
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

  it('downgrades adversarial verifier self-reported verified result without run_tests transcript', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async config => ({
        result: {
          ...resultFor(config.order.id),
          summary: 'Self-reported verified without running tests',
          evidenceStatus: 'verified',
        },
        transcript: { text: '', thinking: '', toolUses: ['read_file'], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_adv_no_tests',
      objective: 'Independently verify the worker evidence gate behavior against the changed coordinator path.',
      kind: 'verify',
      profile: 'adversarial_verifier',
      scope: { files: ['src/agent/coordinator.ts', 'src/agent/worker-evidence.ts'] },
    })

    assert.equal(run.status, 'completed')
    assert.equal(run.results.length, 1)
    assert.equal(run.results[0]!.status, 'passed')
    assert.equal(run.results[0]!.evidenceStatus, 'unverified')
    assert.ok(run.results[0]!.risks.some(r => r.includes('without running run_tests')))
    assert.ok(run.packet.includes('without running run_tests'))
  })

  it('keeps adversarial verifier verified when run_tests appears in transcript', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async config => ({
        result: {
          ...resultFor(config.order.id),
          summary: 'Verified after running tests',
          evidenceStatus: 'verified',
        },
        transcript: { text: '', thinking: '', toolUses: ['read_file', 'run_tests'], toolResults: ['run_tests'], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_adv_tests',
      objective: 'Independently verify the worker evidence gate behavior by running tests after reading code.',
      kind: 'verify',
      profile: 'adversarial_verifier',
      scope: { files: ['src/agent/coordinator.ts', 'src/agent/worker-evidence.ts'] },
    })

    assert.equal(run.status, 'completed')
    assert.equal(run.results.length, 1)
    assert.equal(run.results[0]!.status, 'passed')
    assert.equal(run.results[0]!.evidenceStatus, 'verified')
    assert.ok(!run.results[0]!.risks.some(r => r.includes('without running run_tests')))
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
        client: {} as StreamClient,
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
        client: {} as StreamClient,
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

    // doc_research also maps to repo_summarization → cheap
    await coordinator.delegate({
      parentTurnId: 'turn_r2',
      objective: 'Research the documentation about how surface routing works in this project.',
      kind: 'doc_research',
      profile: 'doc_scout',
      scope: { files: ['docs/superpowers/specs/'] },
    })
    assert.equal(selectedModels[1], 'MiniMax-M2.7')
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
            client: {} as StreamClient,
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
              capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
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
          client: {} as StreamClient,
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

  it('blocks worker when CollaborationProtocol lock is held by another session', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      sessionId: 's-main',
      collaboration: {},
    })

    // External session holds a lock on the same file
    const external = new CollaborationProtocol()
    external.acquireLock('external-session', { operation: 'edit', files: ['src/locked.ts'], description: 'held externally' })

    // Pre-acquire via the coordinator's own protocol (simulating lock conflict)
    // We access the internal collaboration protocol and pre-lock the file
    const cp = (coordinator as unknown as { collaboration: CollaborationProtocol }).collaboration
    cp.acquireLock('other-session', { operation: 'edit', files: ['src/locked.ts'], description: '' })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_lock_1',
      objective: 'Edit the locked file to add new feature implementation details.',
      kind: 'patch_proposal',
      profile: 'patcher',
      scope: { files: ['src/locked.ts'] },
    })

    assert.equal(run.status, 'completed')
    assert.equal(run.results[0]?.status, 'blocked')
    assert.ok(run.results[0]?.summary.includes('Semantic lock conflict'))
  })

  it('allows worker when CollaborationProtocol lock is available', async () => {
    let workerCalled = false
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      sessionId: 's-main',
      collaboration: {},
      runWorker: async config => {
        workerCalled = true
        return {
          result: resultFor(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_lock_2',
      objective: 'Read the source files to understand the module structure and patterns.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/free.ts'] },
    })

    assert.equal(run.status, 'completed')
    assert.ok(workerCalled)
  })

  it('releases CollaborationProtocol locks when worker execution throws', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      sessionId: 's-main',
      collaboration: {},
      runHands: async () => { throw new Error('worker crashed after lock') },
    })

    // B1: delegate no longer rethrows — returns structured degradation.
    // Locks must still be released (finally block runs regardless).
    const degradedRun = await coordinator.delegate({
      parentTurnId: 'turn_lock_throw',
      objective: 'Patch the locked file and intentionally exercise lock cleanup on worker failure.',
      kind: 'patch_proposal',
      profile: 'patcher',
      scope: { files: ['src/semantic-lock-cleanup.ts'] },
    })
    assert.equal(degradedRun.results[0]?.status, 'blocked')
    assert.ok(degradedRun.results[0]?.summary?.includes('worker crashed after lock'))

    const cp = (coordinator as unknown as { collaboration: CollaborationProtocol }).collaboration
    assert.equal(cp.getSessionLocks('s-main').length, 0)
    assert.equal(cp.acquireLock('other-session', { operation: 'edit', files: ['src/semantic-lock-cleanup.ts'], description: 'after failure' }).acquired, true)
  })

  it('releases sessionRegistry file claims after write worker completes', async () => {
    const claims = new Map<string, string>()
    const sessionRegistry = {
      acquireClaim: (sessionId: string, filePath: string) => {
        const owner = claims.get(filePath)
        if (owner && owner !== sessionId) return false
        claims.set(filePath, sessionId)
        return true
      },
      releaseClaim: (sessionId: string, filePath: string) => {
        if (claims.get(filePath) === sessionId) claims.delete(filePath)
      },
    }
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      sessionRegistry: sessionRegistry as never,
      sessionId: 's-main',
      runHands: async config => ({ result: resultFor(config.order.id), usage: {} }),
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_claim_success',
      objective: 'Patch the claimed file and then release the worker claim after completion.',
      kind: 'patch_proposal',
      profile: 'patcher',
      scope: { files: ['src/claim-cleanup.ts'] },
    })

    assert.equal(run.status, 'completed')
    assert.equal(sessionRegistry.acquireClaim('other-session', 'src/claim-cleanup.ts'), true)
  })

  it('releases sessionRegistry file claims when write worker throws', async () => {
    const claims = new Map<string, string>()
    const sessionRegistry = {
      acquireClaim: (sessionId: string, filePath: string) => {
        const owner = claims.get(filePath)
        if (owner && owner !== sessionId) return false
        claims.set(filePath, sessionId)
        return true
      },
      releaseClaim: (sessionId: string, filePath: string) => {
        if (claims.get(filePath) === sessionId) claims.delete(filePath)
      },
    }
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      sessionRegistry: sessionRegistry as never,
      sessionId: 's-main',
      runHands: async () => { throw new Error('worker crashed after claim') },
    })

    // B1: delegate no longer rethrows — returns structured degradation.
    // File claims must still be released (finally block runs regardless).
    const degradedRun = await coordinator.delegate({
      parentTurnId: 'turn_claim_throw',
      objective: 'Patch the claimed file and intentionally exercise file claim cleanup on worker failure.',
      kind: 'patch_proposal',
      profile: 'patcher',
      scope: { files: ['src/claim-failure-cleanup.ts'] },
    })
    assert.equal(degradedRun.results[0]?.status, 'blocked')
    assert.ok(degradedRun.results[0]?.summary?.includes('worker crashed after claim'))

    assert.equal(sessionRegistry.acquireClaim('other-session', 'src/claim-failure-cleanup.ts'), true)
  })

  it('blocks write worker when files are already claimed by another session', async () => {
    const claims = new Map<string, string>()
    // Pre-claim a file for another session
    claims.set('src/blocked-file.ts', 'other-session')
    const sessionRegistry = {
      acquireClaim: (sessionId: string, filePath: string) => {
        const owner = claims.get(filePath)
        if (owner && owner !== sessionId) return false
        claims.set(filePath, sessionId)
        return true
      },
      releaseClaim: (sessionId: string, filePath: string) => {
        if (claims.get(filePath) === sessionId) claims.delete(filePath)
      },
    }
    let runHandsCalled = false
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      sessionRegistry: sessionRegistry as never,
      sessionId: 's-main',
      runHands: async () => {
        runHandsCalled = true
        return { result: resultFor('unreachable'), usage: {} }
      },
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_claim_blocked',
      objective: 'Patch a file that is already claimed by another session.',
      kind: 'patch_proposal',
      profile: 'patcher',
      scope: { files: ['src/blocked-file.ts'] },
    })

    assert.equal(run.status, 'completed')
    assert.equal(run.results[0]?.status, 'blocked')
    assert.ok(run.results[0]?.summary?.includes('文件声明冲突'))
    assert.ok(run.results[0]?.summary?.includes('src/blocked-file.ts'))
    // Worker should NOT be dispatched
    assert.equal(runHandsCalled, false)
    // Claim should still belong to other session
    assert.equal(claims.get('src/blocked-file.ts'), 'other-session')
    assert.equal(sessionRegistry.acquireClaim('s-main', 'src/blocked-file.ts'), false)
  })

  it('T3: retries failed worker with Pro model when budget allows (Flash→Pro escalation)', async () => {
    const escalateCards: ModelCapabilityCard[] = [
      { model: 'cheap-flash', toolUseReliability: 0.7, jsonStability: 0.7, editSuccessRate: 0.5, testRepairRate: 0.5, contextWindow: 1_000_000, cacheEconomics: 'strong', recommendedTasks: ['code_search'] },
      { model: 'deepseek-pro', toolUseReliability: 0.95, jsonStability: 0.95, editSuccessRate: 0.9, testRepairRate: 0.85, contextWindow: 128_000, cacheEconomics: 'medium', recommendedTasks: ['patch_proposal'] },
    ]
    const modelsUsed: string[] = []
    let firstCall = true
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: escalateCards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        modelsUsed.push(card.model)
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 4096, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 4,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async (config) => {
        if (firstCall) {
          firstCall = false
          throw new Error('Flash worker transient failure')
        }
        return {
          result: resultFor('pro-retry'),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_escalation',
      objective: 'Investigate the Flash→Pro escalation when a worker fails transiently.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/test.ts'] },
      budget: { maxRetries: 1, maxTurns: 4, maxTokens: 4096, timeoutMs: 30000 },
    })

    assert.equal(run.status, 'completed')
    // First call used cheap-flash, retry used deepseek-pro
    assert.equal(modelsUsed.length, 2)
    assert.equal(modelsUsed[0], 'cheap-flash')
    assert.equal(modelsUsed[1], 'deepseek-pro')
    // Escalation shadow event emitted
    assert.ok(run.modelTierShadows && run.modelTierShadows.length >= 2, 'expected at least 2 tier shadows')
    const escShadow = run.modelTierShadows!.find(s => s.actualTier === 'strong' && s.reason.includes('Flash→Pro 升级重试'))
    assert.ok(escShadow, 'escalation shadow must be emitted')
    assert.equal(escShadow!.actualModel, 'deepseek-pro')
    assert.ok(run.selectedModel === 'deepseek-pro', 'selected model should be the Pro model')
  })

  it('T3: respects Pro upgrade limit (max 3 per session)', async () => {
    const escalateCards: ModelCapabilityCard[] = [
      { model: 'cheap-flash', toolUseReliability: 0.7, jsonStability: 0.7, editSuccessRate: 0.5, testRepairRate: 0.5, contextWindow: 1_000_000, cacheEconomics: 'strong', recommendedTasks: ['code_search'] },
      { model: 'deepseek-pro', toolUseReliability: 0.95, jsonStability: 0.95, editSuccessRate: 0.9, testRepairRate: 0.85, contextWindow: 128_000, cacheEconomics: 'medium', recommendedTasks: ['patch_proposal'] },
    ]
    const modelsUsed: string[] = []
    let failCount = 0
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: escalateCards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        modelsUsed.push(card.model)
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 4096, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 4,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async (config) => {
        // Fail all 4 attempts — first 3 escalate to Pro, 4th stays Flash
        failCount++
        throw new Error(`Worker failure #${failCount}`)
      },
    })

    // Run 4 failing delegates — only first 3 should escalate
    for (let i = 0; i < 4; i++) {
      await coordinator.delegate({
        parentTurnId: `turn_limit_${i}`,
        objective: `Test escalation limit attempt number ${i + 1} with more words.`,
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/test.ts'] },
        budget: { maxRetries: 1, maxTurns: 4, maxTokens: 4096, timeoutMs: 30000 },
      })
    }

    // Models used: flash(×4) + pro(×3) = 7 runtimeFactory calls
    assert.equal(modelsUsed.length, 7)
    // First 3 delegates: flash → pro escalation
    assert.equal(modelsUsed.filter(m => m === 'deepseek-pro').length, 3)
    // 4th delegate: flash only (no escalation)
    assert.equal(modelsUsed.filter(m => m === 'cheap-flash').length, 4)
  })

  it('escalationCap=off blocks Flash→Pro escalation retry entirely', async () => {
    // 升档重试是全新会话零缓存全量重跑，off 时失败重试必须留在原档卡上，
    // 绝不自动碰 Pro。前置路由不受影响（此单为 cheap 推荐，无升档诉求）。
    const escalateCards: ModelCapabilityCard[] = [
      { model: 'cheap-flash', toolUseReliability: 0.7, jsonStability: 0.7, editSuccessRate: 0.5, testRepairRate: 0.5, contextWindow: 1_000_000, cacheEconomics: 'strong', recommendedTasks: ['code_search'] },
      { model: 'deepseek-pro', toolUseReliability: 0.95, jsonStability: 0.95, editSuccessRate: 0.9, testRepairRate: 0.85, contextWindow: 128_000, cacheEconomics: 'medium', recommendedTasks: ['patch_proposal'] },
    ]
    const modelsUsed: string[] = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: escalateCards,
      maxWorkers: 2,
      escalationCap: 'off',
      runtimeFactory: (order, card, workerRegistry) => {
        modelsUsed.push(card.model)
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 4096, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 4,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async () => {
        throw new Error('Flash worker persistent failure')
      },
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_cap_off',
      objective: 'Verify escalationCap off blocks any automatic Pro escalation retry.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/test.ts'] },
      budget: { maxRetries: 1, maxTurns: 4, maxTokens: 4096, timeoutMs: 30000 },
    })

    assert.equal(run.status, 'completed')
    assert.ok(modelsUsed.length >= 1, 'worker dispatched at least once')
    assert.equal(modelsUsed.filter(m => m === 'deepseek-pro').length, 0, 'Pro model must never be used under escalationCap=off')
    assert.ok(modelsUsed.every(m => m === 'cheap-flash'), 'all attempts stay on the cheap card')
    assert.notEqual(run.results[0]?.status, 'passed')
  })

  it('escalationCap=balanced retries with a balanced card, never the strong card', async () => {
    const cards: ModelCapabilityCard[] = [
      { model: 'cheap-flash', toolUseReliability: 0.7, jsonStability: 0.7, editSuccessRate: 0.5, testRepairRate: 0.5, contextWindow: 1_000_000, cacheEconomics: 'strong', recommendedTasks: ['code_search'] },
      // 名字无 tier 关键词 + 中等能力 → inferModelTierFromCard 判为 balanced
      { model: 'mid-model', toolUseReliability: 0.7, jsonStability: 0.7, editSuccessRate: 0.7, testRepairRate: 0.7, contextWindow: 300_000, cacheEconomics: 'medium', recommendedTasks: ['code_edit'] },
      { model: 'deepseek-pro', toolUseReliability: 0.95, jsonStability: 0.95, editSuccessRate: 0.9, testRepairRate: 0.85, contextWindow: 128_000, cacheEconomics: 'medium', recommendedTasks: ['patch_proposal'] },
    ]
    const modelsUsed: string[] = []
    let firstCall = true
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      escalationCap: 'balanced',
      runtimeFactory: (order, card, workerRegistry) => {
        modelsUsed.push(card.model)
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 4096, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 4,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async () => {
        if (firstCall) {
          firstCall = false
          throw new Error('Flash worker transient failure')
        }
        return {
          result: resultFor('balanced-retry'),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_cap_balanced',
      objective: 'Verify escalation retry is capped at the balanced card tier.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/test.ts'] },
      budget: { maxRetries: 1, maxTurns: 4, maxTokens: 4096, timeoutMs: 30000 },
    })

    assert.equal(run.status, 'completed')
    assert.equal(modelsUsed.length, 2)
    assert.equal(modelsUsed[0], 'cheap-flash')
    assert.equal(modelsUsed[1], 'mid-model', 'retry must use the balanced card')
    assert.equal(modelsUsed.filter(m => m === 'deepseek-pro').length, 0, 'strong card must not be used under balanced cap')
  })

  it('T3: tierLock:cheap profiles (reviewer) are NOT escalated to a strong model', async () => {
    // Review workers are deliberately pinned cheap so they don't evict the main
    // session's prefix cache. A transient failure must stay on the cheap model,
    // never escalate to the strong card (regression guard for cache isolation).
    const escalateCards: ModelCapabilityCard[] = [
      { model: 'cheap-flash', toolUseReliability: 0.7, jsonStability: 0.7, editSuccessRate: 0.5, testRepairRate: 0.5, contextWindow: 1_000_000, cacheEconomics: 'strong', recommendedTasks: ['code_search'] },
      { model: 'deepseek-pro', toolUseReliability: 0.95, jsonStability: 0.95, editSuccessRate: 0.9, testRepairRate: 0.85, contextWindow: 128_000, cacheEconomics: 'medium', recommendedTasks: ['patch_proposal'] },
    ]
    const modelsUsed: string[] = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: escalateCards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        modelsUsed.push(card.model)
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 4096, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 4,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async () => {
        throw new Error('Flash reviewer transient failure')
      },
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_reviewlock',
      objective: 'Review the wiring of the recently changed delegation module thoroughly.',
      kind: 'review',
      profile: 'reviewer',
      scope: { files: ['src/test.ts'] },
      budget: { maxRetries: 1, maxTurns: 4, maxTokens: 4096, timeoutMs: 30000 },
    })

    // Only the cheap model ran — no Pro escalation despite maxRetries > 0.
    assert.ok(!modelsUsed.includes('deepseek-pro'), `reviewer must not escalate to Pro, got: ${modelsUsed.join(',')}`)
    assert.equal(modelsUsed.length, 1)
    assert.equal(modelsUsed[0], 'cheap-flash')
    assert.notEqual(run.selectedModel, 'deepseek-pro')
  })

  it('blocks exploration worker when scope exceeds maxFiles budget without acquiring semantic locks', async () => {
    let runtimeCalled = false
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        runtimeCalled = true
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      sessionId: 's-main',
      collaboration: {},
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_b1',
      objective: 'Search for all test files across the entire codebase.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: Array.from({ length: 25 }, (_, i) => `src/module${i}.ts`), maxFiles: 10 },
    })

    const cp = (coordinator as unknown as { collaboration: CollaborationProtocol }).collaboration
    assert.equal(run.results[0]!.status, 'blocked')
    assert.ok(run.results[0]!.summary.includes('maxFiles'))
    // Empty-packet regression: the model-facing packet must explain the block,
    // not ship an empty [] that invites a blind identical retry.
    assert.ok(run.packet.includes('maxFiles'), 'packet must carry the scope-budget explanation')
    assert.equal(runtimeCalled, false)
    assert.equal(cp.getSessionLocks('s-main').length, 0)
  })

  it('pre-dispatch abort returns a blocked result whose packet carries the reason (empty-packet regression)', async () => {
    const controller = new AbortController()
    controller.abort()
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      abortSignal: controller.signal,
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
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
      parentTurnId: 'turn-pre-abort',
      objective: 'Trace the streaming client reconnect behavior across the api layer.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/api/client.ts'] },
    })

    assert.equal(run.results[0]?.status, 'blocked')
    assert.ok(run.packet.includes('aborted'), 'packet must explain the pre-dispatch abort')
  })

  it('allows exploration worker when scope is within budget', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      runtimeFactory: (order, card, workerRegistry) => {
        return {
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }
      },
      runWorker: async config => ({
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    })

    const run = await coordinator.delegate({
      parentTurnId: 'turn_b2',
      objective: 'Search for test files in the tui directory.',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: Array.from({ length: 5 }, (_, i) => `src/tui/component${i}.tsx`), maxFiles: 10 },
    })

    assert.equal(run.results[0]!.status, 'passed')
  })

  describe('provider health recording', () => {
    const fastcorpProvider = {
      name: 'fastcorp',
      apiKey: 'test-key',
      baseUrl: 'https://example.com/v1',
      protocol: 'openai' as const,
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none' as const, prefixCompletion: false },
      thinking: 'enabled' as const,
      maxTokens: 4096,
      models: [{ id: 'fast-json', contextWindow: 128_000, maxTokens: 4096 }],
      unsupported: [],
    }

    const routing = {
      providers: { fastcorp: fastcorpProvider },
      profiles: { cheap: { provider: 'fastcorp', model: 'fast-json' } },
      routing: { repo_summarization: 'cheap' },
    }

    const runtimeFactory: WorkerRuntimeFactory = (order, card, workerRegistry) => ({
      order,
      client: {} as StreamClient,
      promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
      toolRegistry: workerRegistry,
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: card.contextWindow,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    it('records success on the routed provider when worker run completes', async () => {
      const health = new ProviderHealthTracker()
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: cards,
        maxWorkers: 2,
        runtimeFactory,
        routing,
        providerHealth: health,
        runWorker: async config => ({
          result: resultFor(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      })

      await coordinator.delegate({
        parentTurnId: 'turn_ph1',
        objective: 'Summarize repository documentation layout for onboarding guide.',
        kind: 'doc_research',
        profile: 'code_scout',
        scope: {},
      })

      const fastcorp = health.getWeights().find(h => h.providerId === 'fastcorp')
      assert.ok(fastcorp, 'fastcorp should be registered in the tracker')
      assert.equal(fastcorp.consecutiveSuccesses, 1)
      assert.equal(fastcorp.tier, 'hot')
    })

    it('records failure on the routed provider when worker run throws', async () => {
      const health = new ProviderHealthTracker()
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: cards,
        maxWorkers: 2,
        runtimeFactory,
        routing,
        providerHealth: health,
        runWorker: async () => { throw new Error('502 upstream error') },
      })

      // B1: delegate() no longer rethrows — returns structured degradation
      const degradedRun = await coordinator.delegate({
        parentTurnId: 'turn_ph2',
        objective: 'Summarize repository documentation layout for onboarding guide.',
        kind: 'doc_research',
        profile: 'code_scout',
        scope: {},
      })
      assert.equal(degradedRun.status, 'completed')
      assert.equal(degradedRun.results[0]?.status, 'blocked')
      assert.ok(degradedRun.results[0]?.summary?.includes('502 upstream error'))

      const fastcorp = health.getWeights().find(h => h.providerId === 'fastcorp')
      assert.ok(fastcorp, 'fastcorp should be registered in the tracker')
      assert.equal(fastcorp.consecutiveFailures, 1)
      assert.ok(fastcorp.weight < 1, 'failure should reduce weight')
    })

    it('does not record failure when the worker run is aborted by the caller', async () => {
      const health = new ProviderHealthTracker()
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: cards,
        maxWorkers: 2,
        runtimeFactory,
        routing,
        providerHealth: health,
        runWorker: async () => { throw new Error('Delegation aborted: caller signal fired') },
      })

      // B1: delegate no longer rethrows — it returns structured degradation
      const degradedRun = await coordinator.delegate({
        parentTurnId: 'turn_ph3',
        objective: 'Summarize repository documentation layout for onboarding guide.',
        kind: 'doc_research',
        profile: 'code_scout',
        scope: {},
      })
      assert.equal(degradedRun.status, 'completed')
      assert.equal(degradedRun.results[0]?.status, 'blocked')
      assert.ok(degradedRun.results[0]?.summary?.includes('Delegation aborted'))

      const fastcorp = health.getWeights().find(h => h.providerId === 'fastcorp')
      assert.equal(fastcorp, undefined, 'abort must not touch provider health')
    })
  })

  describe('EFE × provider-health worker routing (Track 1)', () => {
    const neutralSignals = {
      efe: { epistemicValue: 0.5, pragmaticValue: 0.5, noveltyBonus: 0.2, precision: 0.5 },
      sensorium: { complexity: 0.4, pressure: 0.3, confidence: 0.6, stability: 0.8 },
    }

    function makeProvider(name: string, modelId: string) {
      return {
        name,
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        protocol: 'openai' as const,
        capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none' as const, prefixCompletion: false },
        thinking: 'enabled' as const,
        maxTokens: 4096,
        models: [{ id: modelId, contextWindow: 128_000, maxTokens: 4096 }],
        unsupported: [],
      }
    }

    // No routing.routing entry for repo_summarization → explicit routing never
    // matches, so the EFE path (or static fallback) decides.
    const routing = {
      providers: {
        fastcorp: makeProvider('fastcorp', 'fast-json'),
        bigcorp: makeProvider('bigcorp', 'large-cache'),
      },
      profiles: {},
      routing: {},
    }

    function makeCoordinator(opts: {
      health?: ProviderHealthTracker
      efeEnabled: boolean
      auditEvents?: Array<{ kind: string; json: string }>
      selectedModels: string[]
    }) {
      return new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: cards,
        maxWorkers: 2,
        runtimeFactory: (order, card, workerRegistry) => {
          opts.selectedModels.push(card.model)
          return {
            order,
            client: {} as StreamClient,
            promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
            toolRegistry: workerRegistry,
            cwd: '/repo',
            maxTurns: 2,
            contextWindow: card.contextWindow,
            compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
          }
        },
        routing,
        providerHealth: opts.health,
        gatedInfluenceAuditStore: opts.auditEvents
          ? { saveBanditState: (kind, json) => { opts.auditEvents!.push({ kind, json }) } }
          : undefined,
        efeRouting: { enabled: opts.efeEnabled, getSignals: () => neutralSignals },
        runWorker: async config => ({
          result: resultFor(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      })
    }

    const delegateRequest = {
      parentTurnId: 'turn_efe',
      objective: 'Summarize repository documentation layout for onboarding guide.',
      kind: 'doc_research' as const,
      profile: 'code_scout' as const,
      scope: {},
    }

    function coldProvider(health: ProviderHealthTracker, providerId: string) {
      health.registerProvider(providerId)
      // hot → warm (2 failures), warm → cold (3 more)
      for (let i = 0; i < 5; i++) health.recordFailure(providerId)
    }

    it('shadow mode: emits audit event but dispatch uses the static fallback', async () => {
      const selectedModels: string[] = []
      const auditEvents: Array<{ kind: string; json: string }> = []
      const coordinator = makeCoordinator({ efeEnabled: false, auditEvents, selectedModels })

      await coordinator.delegate(delegateRequest)

      // Static fallback for repo_summarization picks large-cache (strong cache + 1M context)
      assert.equal(selectedModels[0], 'large-cache')

      const efeAudit = auditEvents
        .map(e => JSON.parse(e.json))
        .find(e => e.targetId === 'efe_routing:repo_summarization')
      assert.ok(efeAudit, 'EFE routing must emit an audit event even in shadow mode')
      assert.equal(efeAudit.applied, false)
      assert.equal(efeAudit.gateOpen, false)
    })

    it('gated mode: cold provider is excluded from the EFE pool and dispatch follows EFE', async () => {
      const selectedModels: string[] = []
      const health = new ProviderHealthTracker()
      coldProvider(health, 'bigcorp') // large-cache's provider goes cold

      const coordinator = makeCoordinator({ health, efeEnabled: true, selectedModels })
      await coordinator.delegate(delegateRequest)

      // Without health, fallback would pick large-cache; cold exclusion forces fast-json.
      assert.equal(selectedModels[0], 'fast-json')

      const cold = health.getWeights().find(h => h.providerId === 'bigcorp')
      assert.equal(cold?.tier, 'cold')
    })

    it('gated mode audit event records applied=true and the selected model', async () => {
      const selectedModels: string[] = []
      const auditEvents: Array<{ kind: string; json: string }> = []
      const health = new ProviderHealthTracker()
      coldProvider(health, 'bigcorp')

      const coordinator = makeCoordinator({ health, efeEnabled: true, auditEvents, selectedModels })
      await coordinator.delegate(delegateRequest)

      const efeAudit = auditEvents
        .map(e => JSON.parse(e.json))
        .find(e => e.targetId === 'efe_routing:repo_summarization')
      assert.ok(efeAudit, 'gated EFE routing must emit an audit event')
      assert.equal(efeAudit.applied, true)
      assert.equal(efeAudit.evidenceWindow.selectedModel, 'fast-json')
      assert.equal(efeAudit.evidenceWindow.coldExcluded, 1)
    })
  })

  // ── Wave 2: exponential backoff retry ───────────────────────────

  describe('exponential backoff retry', () => {
    it('retries same-model worker on failure and succeeds on second attempt', async () => {
      let calls = 0
      const sleepCalls: number[] = []
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: cards,
        maxWorkers: 1,
        retrySleepFn: async (ms) => { sleepCalls.push(ms) },
        runtimeFactory: (order, card, workerRegistry) => ({
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }),
        runWorker: async config => {
          calls++
          if (calls === 1) throw new Error('transient 429')
          return {
            result: { ...resultFor(config.order.id), status: 'passed' as const },
            transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
            session: { getTurnCount: () => 1 } as never,
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }
        },
      })

      const run = await coordinator.delegateBatch([{
        parentTurnId: 'turn_retry',
        objective: 'Analyze the routing seams and model selection logic across the delegation coordinator module boundary.',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/agent/coordinator.ts'] },
      }])

      assert.equal(run.status, 'completed')
      assert.equal(calls, 2, 'runWorker should be called twice (initial + 1 retry)')
      assert.equal(sleepCalls.length, 1, 'sleep should be called once for first retry')
      assert.equal(sleepCalls[0], 10000, 'first backoff delay should be 10s (base * 2^0)')
    })

    it('respects maxRetries=0 — no retry, immediate failure', async () => {
      let calls = 0
      const sleepCalls: number[] = []
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: cards,
        maxWorkers: 1,
        retrySleepFn: async (ms) => { sleepCalls.push(ms) },
        runtimeFactory: (order, card, workerRegistry) => ({
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }),
        runWorker: async () => {
          calls++
          throw new Error('persistent error')
        },
      })

      const run = await coordinator.delegateBatch([{
        parentTurnId: 'turn_noretry',
        objective: 'Analyze the routing seams and model selection logic across the delegation coordinator module boundary.',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/agent/coordinator.ts'] },
        budget: { maxRetries: 0 },
      }])

      assert.equal(run.status, 'completed')
      assert.equal(calls, 1, 'runWorker called once — no retry')
      assert.equal(sleepCalls.length, 0, 'no sleep calls — retry disabled')
    })

    it('uses exponential delay formula: base * 2^(attempt-1)', async () => {
      let calls = 0
      const sleepCalls: number[] = []
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: cards,
        maxWorkers: 1,
        retrySleepFn: async (ms) => { sleepCalls.push(ms) },
        runtimeFactory: (order, card, workerRegistry) => ({
          order,
          client: {} as StreamClient,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
          toolRegistry: workerRegistry,
          cwd: '/repo',
          maxTurns: 2,
          contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }),
        runWorker: async () => {
          calls++
          throw new Error('persistent error')
        },
      })

      await coordinator.delegateBatch([{
        parentTurnId: 'turn_formula',
        objective: 'Analyze the routing seams and model selection logic across the delegation coordinator module boundary.',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/agent/coordinator.ts'] },
        budget: { maxRetries: 2, retryBackoffMs: 5000, maxRetryBackoffMs: 60000 },
      }])

      assert.equal(sleepCalls.length, 2, 'two sleep calls for maxRetries=2')
      assert.equal(sleepCalls[0], 5000, 'first delay: 5000 * 2^0 = 5000')
      assert.equal(sleepCalls[1], 10000, 'second delay: 5000 * 2^1 = 10000')
    })
  })
})
