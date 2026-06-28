/**
 * End-to-end: drive `/team` (standard) and `/team max` through the REAL
 * DelegationCoordinator + real review router + real telemetry/episode closure,
 * faking only the model boundary (runWorker / runHands). This reproduces the
 * actual final flow the slash commands hit — dispatch → review squadron →
 * reward/episode closure → panel encode — and asserts it runs to completion
 * (isError:false) instead of throwing at the end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTeamOrchestrateTool } from '../team-orchestrate.js'
import type { PlanExecutorDeps } from '../../agent/plan-executor.js'
import { DelegationCoordinator } from '../../agent/coordinator.js'
import type { WorkerSessionConfig, WorkerSessionRun } from '../../agent/worker-session.js'
import type { HandsSessionConfig, HandsSessionRun } from '../../agent/hands-session.js'
import type { WorkerResult } from '../../agent/work-order.js'
import { READ_ONLY_WORKER_TOOLS } from '../../agent/work-order.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { Tool } from '../../tools/types.js'
import { SessionContext } from '../../agent/context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { profileRegistry } from '../../agent/profile-registry.js'
import { mockClientFromTexts } from '../../agent/__tests__/mocks.js'
import { decodeTeamPanelModel } from '../../tui/team-panel-model.js'
import { clearWaveResults } from '../../agent/wave-results-store.js'
import { consumePlan } from '../../agent/plan-store.js'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const EMPTY_TRANSCRIPT = { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 }

function workerResult(over: Partial<WorkerResult> & { workOrderId: string }): WorkerResult {
  return {
    status: 'passed',
    summary: 'ok',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    ...over,
  }
}

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name}`, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: `${name} ok` }),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function baseRegistry(): ToolRegistry {
  // Mirror production: register every tool any built-in profile can allowlist so
  // the coordinator's filterToolRegistry never throws "Cannot allowlist unknown tool".
  const reg = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) reg.register(fakeTool(name))
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) reg.register(fakeTool(tool))
  }
  return reg
}

function minimalPromptEngine(): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4',
    maxTokens: 4096,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/tmp', workingSet: [], playbookLessons: [], activeClaims: [], toolHistory: [], sessionMemoryBlock: '' },
  })
}

/** In-memory reward/episode store (append-only kind→json), enough for the closure. */
function memStore() {
  const m = new Map<string, string[]>()
  return {
    saveBanditState(kind: string, json: string) {
      const arr = m.get(kind) ?? []
      arr.push(json)
      m.set(kind, arr)
    },
    loadBanditStatesByPrefix(prefix: string, limit?: number) {
      const out: Array<{ kind: string; json: string }> = []
      for (const [kind, arr] of m) if (kind.startsWith(prefix)) for (const json of arr) out.push({ kind, json })
      return limit ? out.slice(0, limit) : out
    },
  }
}

const MODEL_CARDS = [{
  model: 'deepseek-v4',
  toolUseReliability: 0.9,
  jsonStability: 0.9,
  editSuccessRate: 0.85,
  testRepairRate: 0.8,
  contextWindow: 128000,
  cacheEconomics: 'strong' as const,
  recommendedTasks: ['code_search', 'review', 'patch'],
}]

function buildCoordinator() {
  return new DelegationCoordinator({
    baseToolRegistry: baseRegistry(),
    modelCards: MODEL_CARDS,
    maxWorkers: 3,
    runtimeFactory: (order, _card, registry): WorkerSessionConfig => ({
      order,
      client: mockClientFromTexts(['unused']),
      promptEngine: minimalPromptEngine(),
      toolRegistry: registry,
      cwd: '/tmp',
      maxTurns: 1,
      contextWindow: 10000,
      compact: { enabled: true, autoThreshold: 8000, autoFloor: 5000, model: 'deepseek-v4' },
    }),
    // Read-only path: planners (kind:'plan') return a perspective-plan artifact
    // carrying one patcher task; everyone else (review squadron) passes.
    runWorker: async (config: WorkerSessionConfig): Promise<WorkerSessionRun> => {
      const order = config.order
      if (order.kind === 'plan') {
        const task = {
          id: 'M1',
          title: 'apply foo edit',
          // Must clear shouldDelegateObjective's ≥6-word / ≥2-file gate, mirroring
          // a real planner's task objective (not a terse stub).
          objective: 'Apply the planned edit to src/agent/foo.ts and add a focused regression test for it',
          files: ['src/agent/foo.ts'],
          profile: 'patcher' as const,
          kind: 'patch_proposal' as const,
          verification: ['npm test'],
          dependsOn: [] as string[],
          riskTier: 'low' as const,
          touchSet: ['src/agent/foo.ts'],
        }
        const plan = {
          perspective: order.authority ?? 'tianquan',
          summary: 'plan',
          tasks: [task],
          dependencyNotes: [],
          risks: [],
          verification: ['npm test'],
          blockers: [],
          alternatives: [],
        }
        return {
          result: workerResult({
            workOrderId: order.id,
            summary: 'planned',
            artifacts: [{ kind: 'note', title: 'perspective-plan', content: JSON.stringify(plan) }],
          }),
          transcript: EMPTY_TRANSCRIPT,
          session: new SessionContext(),
          usage: USAGE,
        }
      }
      return {
        result: workerResult({ workOrderId: order.id, status: 'passed', summary: 'reviewed: acceptance gates verified, no blocking issues' }),
        transcript: EMPTY_TRANSCRIPT,
        session: new SessionContext(),
        usage: USAGE,
      }
    },
    // Write path: patcher tasks land here; report a real change so the review
    // gate fires on the last wave.
    runHands: async (config: HandsSessionConfig): Promise<HandsSessionRun> => ({
      result: workerResult({ workOrderId: config.order.id, status: 'passed', summary: 'applied edits to foo', changedFiles: ['src/agent/foo.ts'] }),
      usage: USAGE,
    }),
  })
}

function buildDeps(coordinator: DelegationCoordinator, sessionId: string) {
  const telemetry: unknown[] = []
  const closures: unknown[] = []
  const store = memStore()
  const deps: PlanExecutorDeps = {
    delegate: (request, abortSignal) => coordinator.delegate(request, abortSignal),
    delegateBatch: (requests, policy, abortSignal, onProgress) => coordinator.delegateBatch(requests, policy, abortSignal, onProgress),
    recordTeamWaveTelemetry: e => { telemetry.push(e) },
    recordTeamWaveRewardClosure: e => { closures.push(e) },
    getTeamSchedulerRewardStore: () => store,
    getSessionId: () => sessionId,
  }
  return { deps, telemetry, closures }
}

test('e2e: /team (standard) runs dispatch + review squadron + closure to completion', async () => {
  const sessionId = 'e2e-team-standard'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  const coordinator = buildCoordinator()
  const { deps, telemetry, closures } = buildDeps(coordinator, sessionId)
  const tool = createTeamOrchestrateTool(deps, { defaultMaxParallel: 3 })

  const md = '### Task 1: edit foo\nModify `src/agent/foo.ts`'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: end-to-end standard team run', planMarkdown: md, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'e2e-std',
    sessionId,
  })

  assert.equal(result.isError, false, `standard run must complete, got: ${result.content}`)
  const panel = decodeTeamPanelModel(result.uiContent ?? '')
  assert.ok(panel && panel.dispatched >= 1, 'at least one worker dispatched')
  // The review squadron actually ran (last wave + real changed files).
  assert.match(result.content, /Review gate \[/)
  // Closure fired end-to-end.
  assert.ok(telemetry.length >= 1, 'telemetry recorded')
  assert.ok(closures.length >= 1, 'reward closure recorded')
})

test('e2e: /team max runs planner fanout + dispatch + review + closure to completion', async () => {
  const sessionId = 'e2e-team-max'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  const coordinator = buildCoordinator()
  const { deps, telemetry } = buildDeps(coordinator, sessionId)
  const tool = createTeamOrchestrateTool(deps, { defaultMaxParallel: 3 })

  const result = await tool.execute({
    input: { mode: 'max', objective: 'force: end-to-end max planning then execution', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'e2e-max',
    sessionId,
  })

  assert.equal(result.isError, false, `max run must complete, got: ${result.content}`)
  const panel = decodeTeamPanelModel(result.uiContent ?? '')
  assert.ok(panel && panel.dispatched >= 1, `max should dispatch the merged plan, content: ${result.content}`)
  assert.match(result.content, /Review gate \[/)
  assert.ok(telemetry.length >= 1, 'telemetry recorded for max')
})
