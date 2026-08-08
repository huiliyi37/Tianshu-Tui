/**
 * 嵌套委派上行 + 运行中转录快照（子代理可观测性）。
 *
 * 契约：
 * - worker 经 onNestedDelegation 上行的 sub-worker 活动，coordinator 盖
 *   parentWorkerId 戳（本 order id）后转发给 request.onNestedActivity
 * - 更深层已盖过 parentWorkerId 的事件原样透传（父子关系以最近一层为准）
 * - onNestedActivity 抛错不影响 dispatch
 * - 终态后 nestedUpstream / liveMessages 表清空（无泄漏）
 * - onSessionReady 注册的活消息 getter 在运行中经 getLiveWorkerMessages 可读，
 *   终态后返回 undefined（读方回落到落盘记录）
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
import type { Tool, ToolCallParams, DelegationActivity } from '../../tools/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

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

function nestedActivity(overrides?: Partial<DelegationActivity>): DelegationActivity {
  return {
    workOrderId: 'wo_sub:S1',
    parentToolId: 'inner-tool-call-7',
    profile: 'code_scout',
    status: 'running',
    progressLine: '⚙ grep auth',
    ...overrides,
  }
}

const baseRequest = {
  parentTurnId: 't-nested',
  objective: 'trace the authentication flow across multiple coordinator modules',
  kind: 'code_search' as const,
  profile: 'code_scout' as const,
  scope: { files: ['a.ts'] },
}

describe('nested delegation upstream', () => {
  it('stamps parentWorkerId with the dispatching order id and forwards', async () => {
    const received: DelegationActivity[] = []
    const coordinator = makeCoordinator(async (config) => {
      config.onNestedDelegation?.(nestedActivity())
      return {
        result: passedResult(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })
    const run = await coordinator.delegate({
      ...baseRequest,
      onNestedActivity: a => received.push(a),
    })
    assert.equal(run.status, 'completed')
    assert.equal(received.length, 1)
    assert.equal(received[0]!.workOrderId, 'wo_sub:S1')
    assert.equal(received[0]!.parentWorkerId, run.results[0]!.workOrderId, '盖上派发方 order id')
    assert.equal(received[0]!.parentAttemptId, run.results[0]!.attemptId, '盖上派发方 attempt id')
  })

  it('preserves a deeper parentWorkerId already stamped downstream', async () => {
    const received: DelegationActivity[] = []
    const coordinator = makeCoordinator(async (config) => {
      // 三级场景：孙 worker 的事件在中间层已盖 parentWorkerId=中间 order id。
      config.onNestedDelegation?.(nestedActivity({ workOrderId: 'wo_leaf:L1', parentWorkerId: 'wo_mid:M1' }))
      return {
        result: passedResult(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })
    await coordinator.delegate({ ...baseRequest, onNestedActivity: a => received.push(a) })
    assert.equal(received.length, 1)
    assert.equal(received[0]!.parentWorkerId, 'wo_mid:M1', '祖先层只透传，不覆盖')
  })

  it('a throwing onNestedActivity does not break dispatch', async () => {
    const coordinator = makeCoordinator(async (config) => {
      config.onNestedDelegation?.(nestedActivity())
      return {
        result: passedResult(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })
    const run = await coordinator.delegate({
      ...baseRequest,
      onNestedActivity: () => { throw new Error('UI exploded') },
    })
    assert.equal(run.status, 'completed')
    assert.equal(run.results[0]!.status, 'passed')
  })

  it('cleans up nestedUpstream after the order completes', async () => {
    const coordinator = makeCoordinator(async (config) => ({
      result: passedResult(config.order.id),
      transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
      session: { getTurnCount: () => 1 } as never,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }))
    await coordinator.delegate({ ...baseRequest, onNestedActivity: () => {} })
    const table = (coordinator as unknown as { nestedUpstream: Map<string, unknown> }).nestedUpstream
    assert.equal(table.size, 0, 'no leaked nested upstream callbacks')
  })
})

describe('live worker transcript snapshot', () => {
  it('exposes in-flight messages via getLiveWorkerMessages, cleared on terminal', async () => {
    const liveMsgs: OaiMessage[] = [
      { role: 'user', content: 'objective' },
      { role: 'assistant', content: 'thinking about it' },
    ]
    let seenDuringRun: readonly OaiMessage[] | undefined
    let coordinatorRef: DelegationCoordinator
    const coordinator = makeCoordinator(async (config) => {
      config.onSessionReady?.(() => liveMsgs)
      seenDuringRun = coordinatorRef.getLiveWorkerMessages(config.order.id)
      return {
        result: passedResult(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })
    coordinatorRef = coordinator
    const run = await coordinator.delegate({ ...baseRequest })
    assert.equal(run.status, 'completed')
    assert.deepEqual(seenDuringRun, liveMsgs, '运行中可读活转录')
    assert.equal(
      coordinator.getLiveWorkerMessages(run.results[0]!.workOrderId),
      undefined,
      '终态后活快照清除,回落到落盘记录',
    )
  })

  it('a throwing live getter degrades to undefined (never breaks the reader)', async () => {
    let orderId = ''
    let seen: readonly OaiMessage[] | undefined | 'unset' = 'unset'
    let coordinatorRef: DelegationCoordinator
    const coordinator = makeCoordinator(async (config) => {
      orderId = config.order.id
      config.onSessionReady?.(() => { throw new Error('session mid-rebuild') })
      seen = coordinatorRef.getLiveWorkerMessages(orderId)
      return {
        result: passedResult(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })
    coordinatorRef = coordinator
    await coordinator.delegate({ ...baseRequest })
    assert.equal(seen, undefined)
  })
})
