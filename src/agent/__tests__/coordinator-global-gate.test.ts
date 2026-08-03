/**
 * 全局并发闸行为测试（P1-6/7/8 审查修复包的行为锁定）。
 *
 * 锁定四条：
 * 1. 写工空 scope.files → blocked；verifier 豁免（合法跑全量测试形态）。
 * 2. 嵌套委派不占全局信号量——maxWorkers=1 时 planner 嵌套派发不死锁。
 * 3. 等槽 abort 感知——parentSignal 触发时等槽 promise 立即 reject。
 * 4. TOCTOU——同 tick 两个同文件写工，恰好一个被跨波冲突拦下。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { DelegationCoordinator } from '../coordinator.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
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
  recommendedTasks: ['code_edit'],
}]

function makeResult(orderId: string, summary = 'done with enough detail to pass the summary quality gate easily without any expansion round at all, covering findings, changes, and open items in one long sentence.'): WorkerResult {
  return {
    workOrderId: orderId,
    status: 'passed',
    summary,
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
  }
}

function runtimeFactoryFor(order: import('../work-order.js').WorkOrder, card: ModelCapabilityCard, workerRegistry: ToolRegistry) {
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

function quickWorker(resultFor: (id: string) => WorkerResult, onOrder?: (order: import('../work-order.js').WorkOrder) => Promise<void> | void) {
  return async (config: { order: import('../work-order.js').WorkOrder }) => {
    await onOrder?.(config.order)
    return {
      result: resultFor(config.order.id),
      transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
      session: { getMessages: () => [], getTurnCount: () => 1 } as never,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
  }
}

describe('global concurrency gate', () => {
  let homeDir: string
  let savedHome: string | undefined

  beforeEach(() => {
    homeDir = mkdtempSync(join('/tmp', 'rivet-gate-'))
    savedHome = process.env.HOME
    process.env.HOME = homeDir
  })

  afterEach(() => {
    process.env.HOME = savedHome
  })

  it('写工空 scope.files → blocked；verifier 空 scope → 放行', async () => {
    const ran: string[] = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      cwd: '/repo',
      runtimeFactory: runtimeFactoryFor,
      runWorker: quickWorker(makeResult, (order) => { ran.push(order.profile) }),
    })

    const patcherRun = await coordinator.delegate({
      parentTurnId: 'gate:1', objective: 'Implement the gamma feature without declaring any files at all', kind: 'patch_proposal', profile: 'patcher', scope: {},
    })
    assert.equal(patcherRun.results[0]!.status, 'blocked', '空 scope 写工必须被拦')
    assert.match(patcherRun.results[0]!.summary, /scope\.files/)

    const verifierRun = await coordinator.delegate({
      parentTurnId: 'gate:2', objective: 'Run the full test suite and report failures', kind: 'verify', profile: 'verifier', scope: {},
    })
    assert.equal(verifierRun.results[0]!.status, 'passed', 'verifier 跑全量测试是合法形态，豁免')
    assert.deepEqual(ran, ['verifier'], 'patcher 被闸在 runWorker 之前')
  })

  it('嵌套委派不占全局信号量——maxWorkers=1 时 planner 嵌套派发不死锁', async () => {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 1,
      cwd: '/repo',
      runtimeFactory: runtimeFactoryFor,
      runWorker: quickWorker(makeResult, async (order) => {
        if ((order.delegationDepth ?? 0) === 0) {
          // planner 本体：持槽期间嵌套派发一个子工（深度 1）
          await coordinator.delegate({
            parentTurnId: 'p0:nested', objective: 'Explore the nested module for routing seams and risk patterns', kind: 'code_search', profile: 'code_scout', scope: {}, delegationDepth: 1,
          })
        }
      }),
    })

    const watchdog = new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('deadlock: nested delegation starved on the global semaphore')), 3000))
    const run = await Promise.race([
      coordinator.delegate({ parentTurnId: 'p0', objective: 'Plan the work and dispatch a nested exploration task', kind: 'plan', profile: 'planner', scope: {}, delegationDepth: 0 }),
      watchdog,
    ])
    assert.equal(run.results[0]!.status, 'passed')
  })

  it('等槽期间 parentSignal 触发 → 等槽 promise 立即 reject（僵尸唤醒修复）', async () => {
    let releaseFirst!: () => void
    let firstCall = true
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 1,
      cwd: '/repo',
      runtimeFactory: runtimeFactoryFor,
      runWorker: async (config: { order: import('../work-order.js').WorkOrder }) => {
        // 首调用者即持槽者（order.id 由 deriveStableWorkOrderId 生成，不可预判）
        if (firstCall) {
          firstCall = false
          await new Promise<void>(r => { releaseFirst = r })
        }
        return {
          result: makeResult(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getMessages: () => [], getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    const first = coordinator.delegate({ parentTurnId: 'holder', objective: 'Hold the only available worker slot for a while', kind: 'code_search', profile: 'code_scout', scope: {} })
    await new Promise(r => setTimeout(r, 20)) // 等 holder 占槽
    const ac = new AbortController()
    const waiting = coordinator.delegate({ parentTurnId: 'waiter', objective: 'Wait patiently for a worker slot to free up', kind: 'code_search', profile: 'code_scout', scope: {} }, ac.signal)
    const outcome = waiting.then(
      () => 'resolved' as const,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    ac.abort()
    assert.notEqual(await outcome, 'resolved', 'abort 必须唤醒等槽 promise 并 reject')
    releaseFirst()
    await first
  })

  it('TOCTOU：同 tick 两个同文件写工，恰好一个被跨波冲突拦下', async () => {
    let peak = 0
    let inflight = 0
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      cwd: '/repo',
      runtimeFactory: runtimeFactoryFor,
      runWorker: async (config: { order: import('../work-order.js').WorkOrder }) => {
        inflight++
        peak = Math.max(peak, inflight)
        await new Promise(r => setTimeout(r, 30))
        inflight--
        return {
          result: makeResult(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getMessages: () => [], getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    const [a, b] = await Promise.all([
      coordinator.delegate({ parentTurnId: 'w:a', objective: 'Edit the shared module with proper tests included', kind: 'patch_proposal', profile: 'patcher', scope: { files: ['src/shared.ts'] } }),
      coordinator.delegate({ parentTurnId: 'w:b', objective: 'Edit the shared module with proper tests included', kind: 'patch_proposal', profile: 'patcher', scope: { files: ['src/shared.ts'] } }),
    ])
    const statuses = [a.results[0]!.status, b.results[0]!.status].sort()
    assert.deepEqual(statuses, ['blocked', 'passed'], '同 tick 双写工必须恰好一放一拦')
    assert.equal(peak, 1, '同文件写工峰值并发必须为 1')
  })
})
