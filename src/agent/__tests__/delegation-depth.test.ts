/**
 * T10 B3: 嵌套委派深度控制。
 *
 * 定调：对齐 Cursor「允许嵌套但门控」——主控(0)→worker(1)→孙worker(2)，不再深。
 * 请求方深度 >= MAX_DELEGATION_DEPTH 时拒绝（结构化 blocked，绝不 throw）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DelegationCoordinator, MAX_DELEGATION_DEPTH } from '../coordinator.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult, type WorkOrder } from '../work-order.js'
import { profileRegistry } from '../profile-registry.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} test tool`, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  // Mirror production: register every tool any built-in profile can allowlist so
  // filterToolRegistry never throws "Cannot allowlist unknown tool" on a stale set.
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) registry.register(fakeTool(tool))
  }
  return registry
}

const cards: ModelCapabilityCard[] = [{
  model: 'test-model',
  toolUseReliability: 0.8,
  jsonStability: 0.8,
  editSuccessRate: 0.7,
  testRepairRate: 0.6,
  contextWindow: 128_000,
  cacheEconomics: 'medium',
  recommendedTasks: ['code_search'],
}]

function passedResult(id: string): WorkerResult {
  return {
    workOrderId: id, status: 'passed', summary: `completed ${id}`, findings: [],
    artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified',
  }
}

function makeCoordinator(capture?: { orders: WorkOrder[] }): DelegationCoordinator {
  return new DelegationCoordinator({
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
    runWorker: async (config) => {
      capture?.orders.push(config.order)
      return {
        result: passedResult(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    },
  })
}

const baseRequest = {
  parentTurnId: 't-depth',
  objective: 'trace the authentication flow across multiple coordinator modules',
  kind: 'code_search' as const,
  profile: 'code_scout' as const,
  scope: { files: ['a.ts', 'b.ts'] },
}

describe('delegation depth cap (B3)', () => {
  it('MAX_DELEGATION_DEPTH is 2 (primary → worker → grand-worker, no deeper)', () => {
    assert.equal(MAX_DELEGATION_DEPTH, 2)
  })

  it('depth 0 (primary) dispatches and the spawned order carries depth 1', async () => {
    const capture = { orders: [] as WorkOrder[] }
    const run = await makeCoordinator(capture).delegate({ ...baseRequest, delegationDepth: 0 })
    assert.equal(run.status, 'completed')
    assert.equal(run.results[0]?.status, 'passed')
    assert.equal(capture.orders[0]?.delegationDepth, 1, 'worker order depth = requester depth + 1')
  })

  it('depth 1 (worker) may still spawn a grand-worker (depth 2)', async () => {
    const capture = { orders: [] as WorkerResult[] & WorkOrder[] }
    const run = await makeCoordinator(capture).delegate({ ...baseRequest, delegationDepth: 1 })
    assert.equal(run.results[0]?.status, 'passed')
    assert.equal(capture.orders[0]?.delegationDepth, 2)
  })

  it('depth 2 (grand-worker) is rejected as a structured blocked result, not a throw', async () => {
    const run = await makeCoordinator().delegate({ ...baseRequest, delegationDepth: 2 })
    assert.equal(run.status, 'completed')
    assert.equal(run.results[0]?.status, 'blocked')
    assert.match(run.results[0]?.summary ?? '', /max delegation depth/i)
    // Empty-packet regression: the packet the model reads must carry the same
    // blocked explanation as `results` — `[]` invites a blind identical retry.
    assert.match(run.packet, /max delegation depth/i)
  })

  it('delegateBatch: depth-capped requests surface blocked, runnable siblings proceed', async () => {
    const run = await makeCoordinator().delegateBatch([
      { ...baseRequest, parentTurnId: 't-b1', delegationDepth: 2 },
      { ...baseRequest, parentTurnId: 't-b2', scope: { files: ['c.ts'] }, delegationDepth: 0 },
    ])
    assert.equal(run.status, 'completed')
    assert.equal(run.results.length, 2)
    const statuses = run.results.map(r => r.status).sort()
    assert.deepEqual(statuses, ['blocked', 'passed'])
  })

  it('delegateBatch: all requests depth-capped → completed with blocked results', async () => {
    const run = await makeCoordinator().delegateBatch([
      { ...baseRequest, delegationDepth: 5 },
    ])
    assert.equal(run.status, 'completed')
    assert.equal(run.results[0]?.status, 'blocked')
  })
})
