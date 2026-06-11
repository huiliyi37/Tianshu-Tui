/**
 * T9 P3 实时上行: coordinator 把 worker 活动事件转发给请求级 onActivity 回调。
 *
 * 契约：
 * - request.onActivity 收到 { workOrderId, profile, kind, detail }
 * - 回调经 zod request→order 转换后仍能送达（side-table，不进 WorkOrder）
 * - 回调抛错不影响 dispatch
 * - delegateBatch 同样转发，事件携带各自 workOrderId
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DelegationCoordinator, type WorkerActivityEvent } from '../coordinator.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
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
  for (const name of ['read_section', 'repo_graph']) registry.register(fakeTool(name))
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

function makeCoordinator(
  runWorker: ConstructorParameters<typeof DelegationCoordinator>[0]['runWorker'],
): DelegationCoordinator {
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
    runWorker,
  })
}

/** Worker stub: emits one tool_use + one text delta, then passes. */
const emittingWorker: ConstructorParameters<typeof DelegationCoordinator>[0]['runWorker'] = async (config) => {
  config.onActivity?.('tool_use', 'read_file')
  config.onActivity?.('text', 'hello')
  return {
    result: passedResult(config.order.id),
    transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
    session: { getTurnCount: () => 1 } as never,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

describe('coordinator activity upstream (T9 P3)', () => {
  it('forwards worker activity to request.onActivity with order identity', async () => {
    const events: WorkerActivityEvent[] = []
    const coordinator = makeCoordinator(emittingWorker)
    const run = await coordinator.delegate({
      parentTurnId: 't-upstream',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts'] },
      onActivity: ev => events.push(ev),
    })
    assert.equal(run.status, 'completed')
    assert.equal(events.length, 2)
    assert.equal(events[0]!.kind, 'tool_use')
    assert.equal(events[0]!.detail, 'read_file')
    assert.equal(events[0]!.profile, 'code_scout')
    assert.ok(events[0]!.workOrderId.length > 0, 'event carries the work order id')
    assert.equal(events[1]!.kind, 'text')
    assert.equal(events[1]!.detail, 'hello')
  })

  it('a throwing upstream callback does not break dispatch', async () => {
    const coordinator = makeCoordinator(emittingWorker)
    const run = await coordinator.delegate({
      parentTurnId: 't-throw',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts'] },
      onActivity: () => { throw new Error('UI exploded') },
    })
    assert.equal(run.status, 'completed')
    assert.equal(run.results[0]!.status, 'passed')
  })

  it('delegateBatch forwards events with per-order identity', async () => {
    const events: WorkerActivityEvent[] = []
    const coordinator = makeCoordinator(emittingWorker)
    const onActivity = (ev: WorkerActivityEvent) => events.push(ev)
    const run = await coordinator.delegateBatch([
      {
        parentTurnId: 'batch:0',
        objective: 'trace the authentication flow across multiple coordinator modules',
        kind: 'code_search', profile: 'code_scout', scope: { files: ['a.ts'] }, onActivity,
      },
      {
        parentTurnId: 'batch:1',
        objective: 'map the compaction thresholds and their consumers across the agent loop',
        kind: 'code_search', profile: 'code_scout', scope: { files: ['b.ts'] }, onActivity,
      },
    ], 'all_required')
    assert.equal(run.status, 'completed')
    const ids = new Set(events.map(e => e.workOrderId))
    assert.equal(ids.size, 2, 'events from two distinct work orders')
    assert.equal(events.filter(e => e.kind === 'tool_use').length, 2)
  })

  it('cleans up the upstream table after the order completes', async () => {
    const coordinator = makeCoordinator(emittingWorker)
    await coordinator.delegate({
      parentTurnId: 't-clean',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts'] },
      onActivity: () => {},
    })
    const table = (coordinator as unknown as { activityUpstream: Map<string, unknown> }).activityUpstream
    assert.equal(table.size, 0, 'no leaked upstream callbacks')
  })
})
