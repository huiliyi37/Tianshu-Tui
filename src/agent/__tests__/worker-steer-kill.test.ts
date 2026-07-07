/**
 * WC: TUI worker 视图直达通道 — coordinator.steerWorker / killWorker。
 *
 * 契约：
 * - steerWorker 只对在跑 order 生效（终态/未知返回 false）
 * - 入队消息经 workerConfig.onSteerDrain 一次性 drain（join('\n') 后清空）
 * - killWorker abort 单个 order 的 controller，批内兄弟不受影响
 * - order 结算后 steer 队列清理，无泄漏
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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

function workerRunResult(id: string) {
  return {
    result: passedResult(id),
    transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
    session: { getTurnCount: () => 1 } as never,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

describe('coordinator steerWorker (WC 输入直达)', () => {
  it('在跑时入队，worker 经 onSteerDrain 收到合并文本，drain 后清空', async () => {
    let drained: string[] = []
    const coordinator = makeCoordinator(async (config) => {
      // worker 在跑：steer 两条消息，然后 drain
      assert.equal(coordinator.steerWorker(config.order.id, '先看 tests 目录'), true)
      assert.equal(coordinator.steerWorker(config.order.id, '别动 fixtures'), true)
      const text = config.onSteerDrain?.()
      if (text) drained.push(text)
      // 第二次 drain 应为空（队列已清空）
      assert.equal(config.onSteerDrain?.(), null)
      return workerRunResult(config.order.id)
    })
    const run = await coordinator.delegate({
      parentTurnId: 't-steer',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts'] },
    })
    assert.equal(run.status, 'completed')
    assert.deepEqual(drained, ['先看 tests 目录\n别动 fixtures'])
  })

  it('未知/已结算 order 的 steer 返回 false 且不入队', async () => {
    const coordinator = makeCoordinator(async (config) => workerRunResult(config.order.id))
    assert.equal(coordinator.steerWorker('wo_nonexistent', 'hello'), false)
    const run = await coordinator.delegate({
      parentTurnId: 't-steer-late',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts'] },
    })
    // 结算后 steer 不可达
    assert.equal(coordinator.steerWorker(run.results[0]!.workOrderId, 'too late'), false)
    const queues = (coordinator as unknown as { steerQueues: Map<string, string[]> }).steerQueues
    assert.equal(queues.size, 0, 'steer 队列结算后无泄漏')
  })
})

describe('coordinator killWorker (WC x 停止)', () => {
  it('abort 单个在跑 order；isWorkerRunning 反映在跑状态', async () => {
    const coordinator = makeCoordinator(async (config) => {
      assert.equal(coordinator.isWorkerRunning(config.order.id), true)
      assert.equal(coordinator.killWorker(config.order.id), true)
      // abort 信号已发出
      assert.equal(config.abortSignal?.aborted, true)
      return workerRunResult(config.order.id)
    })
    const run = await coordinator.delegate({
      parentTurnId: 't-kill',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts'] },
    })
    // worker stub 无视 abort 正常返回 —— 本测试只验证信号通道
    assert.equal(run.results.length, 1)
    assert.equal(coordinator.killWorker(run.results[0]!.workOrderId), false, '结算后 kill 返回 false')
    assert.equal(coordinator.isWorkerRunning(run.results[0]!.workOrderId), false)
  })
})
