/**
 * Summary quality auto-expansion tests.
 *
 * Verifies the coordinator's maybeExpandSummary gate:
 * 1. Brief summaries (< 200 chars) trigger a follow-up expansion turn
 * 2. Sufficient summaries (>= 200 chars) skip expansion
 * 3. Expansion only accepts longer summaries (no regression)
 * 4. Expansion failure keeps the original result
 * 5. Blocked/failed results are not expanded
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { DelegationCoordinator, SUMMARY_MIN_LENGTH } from '../coordinator.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
import { profileRegistry } from '../profile-registry.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TMP_BASE = '/tmp'

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

const LONG_SUMMARY = 'This is a sufficiently long summary that exceeds the minimum threshold of 200 characters. It describes what the worker found: the authentication flow was traced through coordinator.ts, worker-session.ts, and delegate-task.ts. The key finding is that the resume mechanism correctly injects prior messages into the worker session context for continuation.'

const SHORT_SUMMARY = 'Found it.'

function makeResult(orderId: string, status: 'passed' | 'blocked' | 'failed', summary: string): WorkerResult {
  return {
    workOrderId: orderId,
    status,
    summary,
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: status === 'passed' ? 'verified' : 'blocked',
  }
}

describe('summary quality auto-expansion', () => {
  let homeDir: string
  let savedHome: string | undefined

  beforeEach(() => {
    homeDir = mkdtempSync(join(TMP_BASE, 'rivet-summary-'))
    savedHome = process.env.HOME
    process.env.HOME = homeDir
  })

  afterEach(() => {
    process.env.HOME = savedHome
  })

  it('does NOT trigger expansion when summary >= 200 chars', async () => {
    let callCount = 0
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      cwd: '/repo',
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
        callCount++
        return {
          result: makeResult('wo_long', 'passed', LONG_SUMMARY),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getMessages: () => [], getTurnCount: () => 1 } as never,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    const run = await coordinator.delegate({
      parentTurnId: 'tu_summary_long',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts', 'b.ts'] },
    })

    assert.equal(callCount, 1, 'runWorker should be called exactly once (no expansion)')
    assert.equal(run.results[0]!.summary, LONG_SUMMARY)
  })

  it('triggers expansion when summary < 200 chars and result is passed', async () => {
    let callCount = 0
    const EXPANDED_SUMMARY = 'This is an expanded summary that provides much more detail about what the worker accomplished during the investigation. The worker traced the authentication flow, identified three key modules involved, and documented the data flow between them. No files were modified but several risks were identified for future work to address.'

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      cwd: '/repo',
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
        callCount++
        const isFirst = callCount === 1
        const messages: OaiMessage[] = isFirst
          ? [{ role: 'user', content: 'initial' }, { role: 'assistant', content: SHORT_SUMMARY }]
          : [{ role: 'user', content: 'initial' }, { role: 'assistant', content: SHORT_SUMMARY }, { role: 'user', content: 'expand' }, { role: 'assistant', content: EXPANDED_SUMMARY }]
        return {
          result: isFirst ? makeResult('wo_short', 'passed', SHORT_SUMMARY) : makeResult('wo_short', 'passed', EXPANDED_SUMMARY),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getMessages: () => messages, getTurnCount: () => callCount } as never,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    const run = await coordinator.delegate({
      parentTurnId: 'tu_summary_short',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts', 'b.ts'] },
    })

    assert.ok(callCount >= 2, `runWorker should be called at least twice (initial + expansion), got ${callCount}`)
    assert.equal(run.results[0]!.summary, EXPANDED_SUMMARY, 'should use expanded summary')
  })

  it('does NOT expand blocked results', async () => {
    let callCount = 0
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      cwd: '/repo',
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
        callCount++
        return {
          result: makeResult('wo_blocked', 'blocked', 'Too short'),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getMessages: () => [{ role: 'user', content: 'x' }], getTurnCount: () => 1 } as never,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    await coordinator.delegate({
      parentTurnId: 'tu_summary_blocked',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts', 'b.ts'] },
    })

    assert.equal(callCount, 1, 'blocked results should NOT trigger expansion')
  })

  it('keeps original summary when expansion returns shorter result', async () => {
    let callCount = 0
    // The expansion returns an EVEN shorter summary — should not regress
    const EVEN_SHORTER = 'No.'
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      cwd: '/repo',
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
        callCount++
        const isFirst = callCount === 1
        return {
          result: isFirst ? makeResult('wo_keep', 'passed', SHORT_SUMMARY) : makeResult('wo_keep', 'passed', EVEN_SHORTER),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getMessages: () => [{ role: 'user', content: 'x' }], getTurnCount: () => callCount } as never,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    const run = await coordinator.delegate({
      parentTurnId: 'tu_summary_keep',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts', 'b.ts'] },
    })

    assert.ok(callCount >= 2, 'expansion should have been attempted')
    assert.equal(run.results[0]!.summary, SHORT_SUMMARY, 'should keep the original when expansion is shorter')
  })
})
