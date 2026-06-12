/**
 * T10 B1: resume 读回 + B2: 后台 work order。
 *
 * persistWorkerResult 落盘 ~/.rivet/subagents/<id>.json 曾是「只写坟墓」
 * （全库 0 处读回）。loadPersistedResult 补上读路径；delegateBackground
 * 提供 Cursor is_background 式异步派发（父不阻塞，handle 轮询/await）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPersistedResult, DelegationCoordinator } from '../coordinator.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'

describe('coordinator resume (B1: loadPersistedResult)', () => {
  it('loads a previously persisted worker result by id', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const dir = join(home, '.rivet', 'subagents')
    mkdirSync(dir, { recursive: true })
    const result: WorkerResult = {
      workOrderId: 'wo_x', status: 'passed', summary: 'prior findings', findings: [],
      artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified',
    }
    writeFileSync(join(dir, 'wo_x.json'), JSON.stringify(result), 'utf-8')
    const loaded = loadPersistedResult('wo_x', home)
    assert.equal(loaded?.summary, 'prior findings')
    assert.equal(loaded?.status, 'passed')
  })

  it('returns null for an unknown id (cold miss, no throw)', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    assert.equal(loadPersistedResult('nope', home), null)
  })

  it('returns null for unparseable content (no throw)', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const dir = join(home, '.rivet', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wo_bad.json'), 'not json at all', 'utf-8')
    assert.equal(loadPersistedResult('wo_bad', home), null)
  })
})

// ── B2: background work orders ──

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

function makeCoordinator(runWorker: ConstructorParameters<typeof DelegationCoordinator>[0]['runWorker']): DelegationCoordinator {
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

const request = {
  parentTurnId: 't-bg',
  objective: 'trace the authentication flow across multiple coordinator modules',
  kind: 'code_search' as const,
  profile: 'code_scout' as const,
  scope: { files: ['a.ts', 'b.ts'] },
}

describe('background work orders (B2: delegateBackground)', () => {
  it('returns immediately with a handle while the worker is still running', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const coordinator = makeCoordinator(async (config) => {
      await gate
      return {
        result: { workOrderId: config.order.id, status: 'passed', summary: 'done', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })

    const id = coordinator.delegateBackground(request)
    assert.equal(coordinator.getBackgroundRun(id)?.status, 'running', 'caller is not blocked')

    release()
    const run = await coordinator.waitBackgroundRun(id)
    assert.equal(run.status, 'completed')
    assert.equal(coordinator.getBackgroundRun(id)?.status, 'completed')
    assert.equal(coordinator.getBackgroundRun(id)?.run?.results[0]?.status, 'passed')
  })

  it('captures worker failure on the handle and rethrows on await', async () => {
    const coordinator = makeCoordinator(async () => { throw new Error('ECONNRESET socket hang up') })
    const id = coordinator.delegateBackground(request)
    await assert.rejects(coordinator.waitBackgroundRun(id), /ECONNRESET/)
    assert.equal(coordinator.getBackgroundRun(id)?.status, 'failed')
    assert.match(coordinator.getBackgroundRun(id)?.error ?? '', /ECONNRESET/)
  })

  it('lists background runs newest first and rejects unknown ids', async () => {
    const coordinator = makeCoordinator(async (config) => ({
      result: { workOrderId: config.order.id, status: 'passed', summary: 'ok', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' },
      transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
      session: { getTurnCount: () => 1 } as never,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }))
    const a = coordinator.delegateBackground(request)
    const b = coordinator.delegateBackground({ ...request, parentTurnId: 't-bg-2' })
    await Promise.all([coordinator.waitBackgroundRun(a), coordinator.waitBackgroundRun(b)])
    assert.equal(coordinator.listBackgroundRuns().length, 2)
    await assert.rejects(coordinator.waitBackgroundRun('bg_nope'), /Unknown background run/)
  })
})

// ── P1-1: retry claim conflict ──

describe('P1-1 retry claim conflict (Pro upgrade blocked by lock)', () => {
  it('returns blocked when retry claim is held by another session, with rollback', async () => {
    // Stateful mock: first acquire succeeds (2 files), retry partial failure
    let acquireCallCount = 0
    const releasedFiles: string[][] = []
    const sessionRegistry = {
      acquireClaim: (_sid: string, _file: string, _type: string) => {
        acquireCallCount++
        // Calls 1-2 (first attempt): succeed
        // Call 3 (retry, first file): succeed — added to retryClaimFiles
        // Call 4 (retry, second file): fail — simulating another session holding this lock
        return acquireCallCount <= 3
      },
      releaseClaim: (_sid: string, file: string) => {
        if (releasedFiles.length === 0 || releasedFiles[releasedFiles.length - 1]!.length >= 2) {
          releasedFiles.push([])
        }
        releasedFiles[releasedFiles.length - 1]!.push(file)
      },
      publishEvent: () => {},
      getLastCycleClose: () => undefined,
      setCycleClose: () => {},
    }

    // runHands mock: throws on every call to trigger retry
    let handsCallCount = 0
    const runHands = async () => {
      handsCallCount++
      throw new Error('ECONNRESET socket hang up')
    }

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: (() => {
        const reg = makeRegistry()
        for (const name of ['edit_file', 'write_file', 'bash', 'run_tests']) reg.register(fakeTool(name))
        return reg
      })(),
      modelCards: [
        ...cards,
        // Strong-tier card for retry: lower capability scores so balanced card
        // is selected first, triggering Flash→Pro escalation
        { model: 'pro-model', toolUseReliability: 0.5, jsonStability: 0.5, editSuccessRate: 0.4, testRepairRate: 0.3, contextWindow: 1_000_000, cacheEconomics: 'medium', recommendedTasks: [] },
      ],
      maxWorkers: 1,
      sessionRegistry: sessionRegistry as any,
      sessionId: 'session-1',
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
        throw new Error('should not be reached — runHands is mocked')
      },
      runHands,
    })

    const patcherRequest = {
      parentTurnId: 't-p1',
      objective: 'apply patch to fix the authentication race condition across modules',
      kind: 'patch_proposal' as const,
      profile: 'patcher' as const,
      scope: { files: ['auth.ts', 'session.ts'] },
    }

    const run = await coordinator.delegate(patcherRequest)

    // Assert: first attempt was made (runHands called once)
    assert.equal(handsCallCount, 1, 'first attempt should call runHands')
    // Assert: retry was blocked by claim conflict
    assert.equal(run.status, 'completed')
    assert.equal(run.results[0]?.status, 'blocked')
    assert.match(run.results[0]?.summary ?? '', /Retry blocked.*claimed by another session/)
    // Assert: original claims were released (first release) + retry rollback
    assert.ok(releasedFiles.length >= 2, `claims released ${releasedFiles.length} times, expected >=2`)
    // Assert: telemetry fields present
    assert.equal(run.selectedModel, 'pro-model')
    assert.ok(Array.isArray(run.modelTierShadows))
  })
})
