import type { ContentBlock } from '../api/types.js'
import type { TurnBudget } from './turn-budget.js'
import { enforcePerMessageBudget, enforceTurnReadBudget, enforceContextPressureTruncation } from './per-message-budget.js'
import { perMessageToolResultBudget } from '../compact/constants.js'
import type { AgentConfig, AgentCallbacks } from './loop-types.js'
import type { TurnHarness } from './turn-harness.js'
import type { EvidenceTracker } from './evidence.js'
import type { TraceStore } from './trace-store.js'
import type { RepairHintTracker } from './repair-hint.js'
import type { RepairPipeline } from './repair-pipeline.js'
import type { ImportGraph } from './import-graph.js'
import type { PredictionAccumulator } from './prediction-error.js'
import type { VigorState } from './vigor.js'
import type { RuntimeHookSnapshot, RuntimeHookPipeline } from './runtime-hooks.js'
import type { ContextInjectionController } from './context-injection.js'
import type { RiskAssessment } from './approval-risk.js'
import type { Sensorium } from './sensorium.js'
import type { TrajectoryRecorder } from './trajectory.js'
import type { ReliabilityDecision } from './reliability-mode.js'
import { PrewarmCache } from './prewarm.js'
import { executeToolUse, type ToolPipelineDeps } from './tool-pipeline.js'
import type { CacheAdvisor } from '../cache/advisor.js'
import type { P3Integration } from './p3-integration.js'
import type { ImmuneHook } from './immune-hook.js'
import type { LspManager } from '../lsp/manager.js'
import { classifyFailure } from './failure-classifier.js'
import {
  getInterventionLevel,
  recordPrediction,
  shouldTippingPointReset,
  resetAccumulator,
  adjustReasoningEffort,
  getErrorRate,
} from './prediction-error.js'
import type { ReasoningEffort } from './auto-reasoning.js'
import { createRuntimeHookContext } from './runtime-hooks.js'

export interface ToolExecutionDeps {
  config: AgentConfig
  cwd: string
  harness: TurnHarness
  prewarm: PrewarmCache
  evidence: EvidenceTracker
  repairHintTracker: RepairHintTracker
  repairPipeline: RepairPipeline
  runtimeHooks: RuntimeHookPipeline
  contextInjection: ContextInjectionController
  trajectory: TrajectoryRecorder
  getPredictionAccumulator: () => PredictionAccumulator
  setPredictionAccumulator: (a: PredictionAccumulator) => void
  getVigorState: () => VigorState
  setVigorState: (v: VigorState) => void
  getDoomLoopLevel: () => 'none' | 'warn' | 'blocked'
  getSessionTurnCount: () => number
  getSessionId: () => string | undefined
  addToolResults: (results: ContentBlock[]) => void
  recordToolHistory: (name: string, input: Record<string, unknown>, isError: boolean, content: string) => void
  buildRuntimeSnapshot: (extra?: Partial<RuntimeHookSnapshot>) => RuntimeHookSnapshot
  requestThetaCheck: (reason: string) => void
  getAutoReasoning: () => boolean
  getReasoningEffort: () => ReasoningEffort | undefined
  setClientReasoningEffort: (effort: ReasoningEffort) => void
  getSensorium: () => Sensorium | null
  getReliabilityDecision: () => ReliabilityDecision | null
  getTurnBudget: () => TurnBudget
  /** Artifact store for persisting tool output — injected via params, no global setter */
  artifactStore?: import('../artifact/store.js').ArtifactStore
  /** Session state manager for cross-turn awareness */
  sessionStateManager?: import('./session-state.js').SessionStateManager
  /** Cache advisor for adaptive thresholds */
  cacheAdvisor?: CacheAdvisor
  /** P3 integration facade */
  p3?: P3Integration
  /** Immune system hook (forwarded to tool-pipeline for adaptive learning) */
  immuneHook?: ImmuneHook
  /** Current StarPhase mapped to phaseClass. Used by tool-pipeline for phase-aware
   *  prediction recording — e.g., TDD RED in verify phase is NOT a prediction error. */
  getPhaseHint?: () => string | undefined
  /** Optional LSP manager — notified on file changes for goto-def / find-refs accuracy. */
  /** Optional LSP manager — notified on file changes for goto-def / find-refs accuracy. */
  lspManager?: LspManager
  /** Session-level estimated token count — enables context-pressure-aware truncation. */
  getEstimatedTokens?: () => number
}

export interface ToolExecBatchInput {
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
  callbacks: AgentCallbacks
  turn: number
  checkpointCreatedThisTurn: boolean
  abortSignal: AbortSignal
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  latestRisk: RiskAssessment
}

export interface ToolExecBatchResult {
  latestRisk: RiskAssessment
}

export interface ToolExecBatchResult {
  checkpointCreated: boolean
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  latestRisk: RiskAssessment
  /** Artifact IDs created (evicted) this batch — for GhostRegistry */
  artifactIdsEvicted: string[]
  /** Artifact IDs accessed (read_section) this batch — for GhostRegistry */
  artifactIdsAccessed: string[]
}

export class ToolExecutionController {
  constructor(private deps: ToolExecutionDeps) {}

  /**
   * T2-02 P0: Shadow telemetry for effort bandit at intervention adjustment point.
   * Records what the bandit would recommend without changing behavior.
   */
  private shadowEffortAdjustment(oldEffort: string, newEffort: string): void {
    try {
      if (!this.deps.p3) return
      // Build lightweight context from available deps
      const predAcc = this.deps.getPredictionAccumulator()
      const errorRate = getErrorRate(predAcc)
      const ctx = [
        Math.min(1, errorRate * 2),                  // taskComplexity proxy
        errorRate,                                     // errorRate
        Math.min(1, this.deps.getSessionTurnCount() / 50), // turnDepth
        0,                                             // fileCount (not accessible at this level)
        0,                                             // isRepeat (not accessible)
        new Date().getHours() / 24,                    // timeOfDay
      ]
      this.deps.p3.shadowRecommendEffort(ctx, newEffort)
    } catch {
      // Shadow telemetry must never affect behavior
    }
  }

  async executeBatch(input: ToolExecBatchInput): Promise<ToolExecBatchResult> {
    const toolResults: ContentBlock[] = []
    let checkpointCreatedThisTurn = input.checkpointCreatedThisTurn
    let traceStore = input.traceStore
    let importGraph = input.importGraph
    let lastConflictCheckCount = input.lastConflictCheckCount
    let latestRisk = input.latestRisk
    const artifactIdsEvicted: string[] = []
    const artifactIdsAccessed: string[] = []

    // Partition tools into concurrency-safe (parallelizable) and sequential groups.
    // Run contiguous blocks of safe tools in parallel for latency savings.
    const indexed = input.toolUses.map((tu, i) => ({ tu, i, safe: this.deps.config.toolRegistry.get(tu.name)?.isConcurrencySafe() ?? false }))

    let cursor = 0
    while (cursor < indexed.length) {
      if (input.abortSignal.aborted) break

      // Collect contiguous safe tools for parallel execution
      if (indexed[cursor]!.safe) {
        const batchStart = cursor
        while (cursor < indexed.length && indexed[cursor]!.safe) cursor++
        const batch = indexed.slice(batchStart, cursor)

        const makeDeps = (): ToolPipelineDeps => ({
          config: this.deps.config,
          cwd: this.deps.cwd,
          harness: this.deps.harness,
          prewarm: this.deps.prewarm,
          evidence: this.deps.evidence,
          traceStore,
          repairHintTracker: this.deps.repairHintTracker,
          repairPipeline: this.deps.repairPipeline,
          importGraph,
          lastConflictCheckCount,
          trajectory: this.deps.trajectory,
          getDoomLoopLevel: () => this.deps.getDoomLoopLevel(),
          latestRisk,
          sessionTurnCount: this.deps.getSessionTurnCount(),
          sessionId: this.deps.getSessionId(),
          recordToolHistory: (name, input_, isError, content) =>
            this.deps.recordToolHistory(name, input_, isError, content),
          getInterventionLevel: () => getInterventionLevel(this.deps.getPredictionAccumulator()),
          recordPrediction: (correct) => {
            this.deps.setPredictionAccumulator(
              recordPrediction(this.deps.getPredictionAccumulator(), correct),
            )
         },
          getSensorium: () => this.deps.getSensorium(),
          getReliabilityDecision: () => this.deps.getReliabilityDecision(),
          turnBudget: this.deps.getTurnBudget(),
          artifactStore: this.deps.artifactStore,
          cacheAdvisor: this.deps.cacheAdvisor,
          taskLedger: this.deps.config.taskLedger,
          ownershipLedger: this.deps.config.ownershipLedger,
          sessionRegistry: this.deps.config.sessionRegistry,
          p3: this.deps.p3,
          immuneHook: this.deps.immuneHook,
          phaseHint: this.deps.getPhaseHint?.(),
          artifactIdsEvicted,
          artifactIdsAccessed,
          lspManager: this.deps.lspManager,
          // Thread the batch-level abort signal into per-tool deps. Without this,
          // deps.abortSignal stays undefined, delegate_task passes undefined to
          // coordinator.delegate, and the entire coordinator abort path becomes
          // dead code — workers hang past the caller timeout ("No response 3m")
          // and leak detached bash children. (root-cause analysis 2026-06-05)
          abortSignal: input.abortSignal,
       })

        const results = await Promise.all(
          batch.map(({ tu }) => executeToolUse(tu, makeDeps(), input.callbacks, input.turn, checkpointCreatedThisTurn)),
        )
        for (const result of results) {
          traceStore = result.traceStore
          importGraph = result.importGraph
          lastConflictCheckCount = result.lastConflictCheckCount
          latestRisk = result.latestRisk
          if (result.checkpointCreated) checkpointCreatedThisTurn = true
          toolResults.push(result.toolResult)
       }
     } else {
        // Sequential execution for non-safe tools
        const { tu } = indexed[cursor]!
        cursor++

        const pipelineDeps: ToolPipelineDeps = {
          config: this.deps.config,
          cwd: this.deps.cwd,
          harness: this.deps.harness,
          prewarm: this.deps.prewarm,
          evidence: this.deps.evidence,
          traceStore,
          repairHintTracker: this.deps.repairHintTracker,
          repairPipeline: this.deps.repairPipeline,
          importGraph,
          lastConflictCheckCount,
          trajectory: this.deps.trajectory,
          getDoomLoopLevel: () => this.deps.getDoomLoopLevel(),
          latestRisk,
          sessionTurnCount: this.deps.getSessionTurnCount(),
          sessionId: this.deps.getSessionId(),
          recordToolHistory: (name, input_, isError, content) =>
            this.deps.recordToolHistory(name, input_, isError, content),
          getInterventionLevel: () => getInterventionLevel(this.deps.getPredictionAccumulator()),
          recordPrediction: (correct) => {
            this.deps.setPredictionAccumulator(
              recordPrediction(this.deps.getPredictionAccumulator(), correct),
            )
         },
          getSensorium: () => this.deps.getSensorium(),
          getReliabilityDecision: () => this.deps.getReliabilityDecision(),
          turnBudget: this.deps.getTurnBudget(),
          artifactStore: this.deps.artifactStore,
          cacheAdvisor: this.deps.cacheAdvisor,
          taskLedger: this.deps.config.taskLedger,
          ownershipLedger: this.deps.config.ownershipLedger,
          sessionRegistry: this.deps.config.sessionRegistry,
          p3: this.deps.p3,
          immuneHook: this.deps.immuneHook,
          phaseHint: this.deps.getPhaseHint?.(),
          artifactIdsEvicted,
          artifactIdsAccessed,
          lspManager: this.deps.lspManager,
          // See makeDeps above — same abort-signal threading for the sequential
          // (non-safe) tool path. (root-cause analysis 2026-06-05)
          abortSignal: input.abortSignal,
       }

        const result = await executeToolUse(tu, pipelineDeps, input.callbacks, input.turn, checkpointCreatedThisTurn)
        traceStore = result.traceStore
        importGraph = result.importGraph
        lastConflictCheckCount = result.lastConflictCheckCount
        latestRisk = result.latestRisk
        if (result.checkpointCreated) checkpointCreatedThisTurn = true
        toolResults.push(result.toolResult)
     }
   }

    // Drain steer guidance ONLY when there is a tool_result to attach it to.
    // onSteerDrain() empties the buffer, so calling it without a valid injection
    // target (e.g. abort broke the loop before any result, or last block is not
    // a tool_result) would discard the guidance. Peek the target first; if absent,
    // leave the buffer intact so the next tool-using turn injects it.
    const lastResult = toolResults.length > 0 ? toolResults[toolResults.length - 1]! : null
    if (lastResult && lastResult.type === 'tool_result') {
      const steerText = input.callbacks.onSteerDrain?.()
      if (steerText) {
        const existing = typeof lastResult.content === 'string' ? lastResult.content : ''
        toolResults[toolResults.length - 1] = { ...lastResult, content: existing + '\n\n' + steerText }
      }
    }

    // Enforce per-message aggregate budget before adding to conversation.
    const budgetEntries = toolResults
      .map((r, i) => r.type === 'tool_result'
        ? { toolUseId: r.tool_use_id, content: typeof r.content === 'string' ? r.content : '', toolName: input.toolUses[i]?.name ?? '' }
        : null)
      .filter((e): e is NonNullable<typeof e> => e !== null)
    const enforced = enforcePerMessageBudget(budgetEntries, perMessageToolResultBudget(this.deps.config.contextWindow))
    for (const entry of enforced) {
      const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === entry.toolUseId)
      if (idx >= 0) {
        const orig = toolResults[idx]!
        if (orig.type === 'tool_result' && entry.content !== (typeof orig.content === 'string' ? orig.content : '')) {
          toolResults[idx] = { ...orig, content: entry.content }
       }
     }
   }

    // Enforce per-turn read budget: truncate read_file results when cumulative
    // chars exceed 15% of the context window.
    const readEnforced = enforceTurnReadBudget(enforced, this.deps.config.contextWindow)
    for (const entry of readEnforced) {
      const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === entry.toolUseId)
      if (idx >= 0) {
        const orig = toolResults[idx]!
        if (orig.type === 'tool_result' && entry.content !== (typeof orig.content === 'string' ? orig.content : '')) {
          toolResults[idx] = { ...orig, content: entry.content }
       }
     }
    // Context-pressure preflight: when estimated context usage >70%, truncate
    // large read_file results to head-only to prevent context overflow.
    const estimatedTokens = this.deps.getEstimatedTokens?.()
    const ctxWindow = this.deps.config.contextWindow
    if (estimatedTokens != null && ctxWindow != null && ctxWindow > 0) {
      const usageRatio = estimatedTokens / ctxWindow
      const pressureEntries = readEnforced
      const pressureEnforced = enforceContextPressureTruncation(pressureEntries, usageRatio)
      for (const entry of pressureEnforced) {
        const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === entry.toolUseId)
        if (idx >= 0) {
          const orig = toolResults[idx]!
          if (orig.type === 'tool_result' && entry.content !== (typeof orig.content === 'string' ? orig.content : '')) {
            toolResults[idx] = { ...orig, content: entry.content }
         }
       }
     }
     }
   }

    this.deps.addToolResults(toolResults)

    const level = getInterventionLevel(this.deps.getPredictionAccumulator())
    this.deps.contextInjection.setCerebellarHint(level)

    for (const tu of input.toolUses) {
      const result = toolResults.find(r => r.type === 'tool_result' && r.tool_use_id === tu.id)
      const target =
        typeof tu.input?.file_path === 'string'
          ? tu.input.file_path
          : typeof tu.input?.path === 'string'
            ? tu.input.path
            : typeof tu.input?.command === 'string'
              ? tu.input.command.slice(0, 50)
              : undefined
      await this.deps.runtimeHooks.runPostTool(
        createRuntimeHookContext(
          this.deps.buildRuntimeSnapshot(),
          {
            setVigor: (vigor) => { this.deps.setVigorState(vigor) },
            requestThetaCheck: (reason) => { this.deps.requestThetaCheck(reason) },
            markClaimStale: claimId => {
              this.deps.config.contextClaimStore?.updateClaimStatus(
                claimId,
                'stale',
                `invalidated by ${tu.name}${target ? ` on ${target}` : ''}`,
              )
           },
         },
        ),
        {
          name: tu.name,
          success: !(result && 'is_error' in result && result.is_error === true),
          isError: result && 'is_error' in result ? result.is_error === true : false,
          target,
          input: tu.input,
          // Classify failure for vigor: environment issues (timeout, api_error)
          // get reduced phasic penalty vs semantic failures (type_error, assertion).
          failureClass: result && 'is_error' in result && result.is_error === true
            ? classifyFailure(typeof result.content === 'string' ? result.content : '').class
            : undefined,
       },
      )
   }

    // Update session state based on tool results
    const mgr = this.deps.sessionStateManager
    if (mgr) {
      for (const tu of input.toolUses) {
        const result = toolResults.find(r => r.type === 'tool_result' && r.tool_use_id === tu.id)
        const isError = result && 'is_error' in result ? result.is_error === true : false
        if (!isError) {
          if (tu.name === 'read_file' && typeof tu.input?.file_path === 'string') {
            mgr.trackFileRead(tu.input.file_path, `read:${tu.id}`)
         }
          if ((tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input?.file_path === 'string') {
            mgr.trackFileModified(tu.input.file_path)
         }
       }
        if (tu.name === 'run_tests') {
          const target = typeof tu.input?.filter === 'string' ? tu.input.filter : 'tests'
          mgr.recordVerification(target, isError ? 'failed' : 'passed')
       }
     }
   }

    if (shouldTippingPointReset(this.deps.getPredictionAccumulator())) {
      this.deps.setPredictionAccumulator(resetAccumulator(this.deps.getPredictionAccumulator()))
      this.deps.contextInjection.clearCerebellarHint()
   }
    if (this.deps.getAutoReasoning() && this.deps.getReasoningEffort()) {
      const newEffort = adjustReasoningEffort(this.deps.getReasoningEffort()!, level)
      // T2-02 P0: shadow telemetry — record bandit recommendation without changing behavior
      this.shadowEffortAdjustment(this.deps.getReasoningEffort()!, newEffort)
      this.deps.setClientReasoningEffort(newEffort)
   }

    return { checkpointCreated: checkpointCreatedThisTurn, traceStore, importGraph, lastConflictCheckCount, latestRisk, artifactIdsEvicted, artifactIdsAccessed }
 }
}
