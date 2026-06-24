/**
 * T10 A4: in-flight worker stall detection.
 *
 * 契约：worker 因「静默」被收，不因「干得久」被收。
 * - stalled(): 静默超过容忍 → 上报
 * - tick(): 任何活动重置时钟
 * - unregister(): 完成后不再误报
 * - coordinator 集成：stall sweep 只收卡死 worker，不连坐同批兄弟
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WorkerLiveness, EXPLORE_STALL_MS, WRITE_STALL_MS } from '../worker-liveness.js'
import { DelegationCoordinator } from '../coordinator.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
import { profileRegistry } from '../profile-registry.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'

describe('worker liveness sweep', () => {
  it('flags a worker stalled beyond stallMs as not-alive', () => {
    let now = 0
    const live = new WorkerLiveness({ stallMs: 60_000, now: () => now })
    live.register('wo1')
    live.tick('wo1')
    now = 30_000
    assert.equal(live.stalled().length, 0, 'within window — not stalled')
    now = 61_000
    assert.deepEqual(live.stalled(), ['wo1'], 'past stallMs with no tick — stalled')
  })

  it('a ticked worker resets its stall clock', () => {
    let now = 0
    const live = new WorkerLiveness({ stallMs: 60_000, now: () => now })
    live.register('wo1')
    now = 50_000; live.tick('wo1')
    now = 100_000
    assert.equal(live.stalled().length, 0, 'tick reset the clock')
  })

  it('unregister stops tracking (no false stall after completion)', () => {
    let now = 0
    const live = new WorkerLiveness({ stallMs: 60_000, now: () => now })
    live.register('wo1'); live.unregister('wo1')
    now = 999_000
    assert.equal(live.stalled().length, 0)
  })

  it('per-worker stall tolerance overrides the default', () => {
    let now = 0
    const live = new WorkerLiveness({ stallMs: 60_000, now: () => now })
    live.register('explore')
    live.register('write', 120_000)
    now = 90_000
    assert.deepEqual(live.stalled(), ['explore'], 'only the default-tolerance worker stalls at 90s')
    now = 121_000
    assert.deepEqual(live.stalled().sort(), ['explore', 'write'])
  })

  it('write tolerance exceeds explore tolerance (edits pause longer)', () => {
    assert.ok(WRITE_STALL_MS > EXPLORE_STALL_MS)
  })
})

// ── Coordinator integration: stall sweep aborts only the wedged worker ──

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

function makeCoordinator(over: {
  workerStallMs: number
  runWorker: ConstructorParameters<typeof DelegationCoordinator>[0]['runWorker']
  maxWorkers?: number
}): DelegationCoordinator {
  return new DelegationCoordinator({
    baseToolRegistry: makeRegistry(),
    modelCards: cards,
    maxWorkers: over.maxWorkers ?? 2,
    workerStallMs: over.workerStallMs,
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
    runWorker: over.runWorker,
  })
}

describe('coordinator stall sweep (A4 integration)', () => {
  it('aborts a silent worker via the stall sweep — delegate rejects with stall error', async () => {
    const coordinator = makeCoordinator({
      workerStallMs: 150,
      // Wedged worker: never produces activity, never resolves on its own,
      // but honors abort (like a real AgentLoop would).
      runWorker: (config) => new Promise((_resolve, reject) => {
        config.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    })
    await assert.rejects(
      coordinator.delegate({
        parentTurnId: 't-stall',
        objective: 'trace the authentication flow across multiple coordinator modules',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['a.ts', 'b.ts'] },
      }),
      /stalled.*liveness/i,
    )
  })

  it('a worker emitting activity is NOT stalled (ticks reset the clock)', async () => {
    const coordinator = makeCoordinator({
      workerStallMs: 200,
      runWorker: async (config) => {
        // Emit activity every 50ms for 600ms — silence never exceeds 200ms.
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 50))
          config.onActivity?.('text')
        }
        return {
          result: passedResult(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })
    const run = await coordinator.delegate({
      parentTurnId: 't-active',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts', 'b.ts'] },
    })
    assert.equal(run.status, 'completed')
    assert.equal(run.results[0]?.status, 'passed', 'active worker must survive past stallMs wall-clock')
  })

  it('batch: stalled worker falls to failure result, sibling completes unaffected', async () => {
    const coordinator = makeCoordinator({
      workerStallMs: 150,
      maxWorkers: 2,
      runWorker: (config) => {
        if (config.order.objective.includes('WEDGE')) {
          return new Promise((_resolve, reject) => {
            config.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }
        return new Promise((resolve) => {
          // Healthy sibling: brief activity then resolve.
          config.onActivity?.('text')
          setTimeout(() => resolve({
            result: passedResult(config.order.id),
            transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
            session: { getTurnCount: () => 1 } as never,
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }), 30)
        })
      },
    })
    const run = await coordinator.delegateBatch([
      {
        parentTurnId: 't-batch-1',
        objective: 'WEDGE — simulate a worker that hangs silently during code search',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['a.ts'] },
      },
      {
        parentTurnId: 't-batch-2',
        objective: 'trace the authentication flow across multiple coordinator modules',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['b.ts'] },
      },
    ])
    assert.equal(run.status, 'completed')
    assert.equal(run.results.length, 2, 'both orders must produce results')
    const statuses = run.results.map(r => r.status).sort()
    assert.ok(statuses.includes('passed'), 'healthy sibling must pass')
    assert.ok(statuses.includes('blocked') || statuses.includes('failed'), 'stalled worker must surface as failure, not hang')
  })
})
