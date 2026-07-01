import type { ContentBlock } from '../api/types.js'
import type { TurnBudget } from './turn-budget.js'
import { enforcePerMessageBudget, enforceTurnReadBudget, enforceContextPressureTruncation, enforceToolTypeBudgets } from './per-message-budget.js'
import { perMessageToolResultBudget } from '../compact/constants.js'
import type { AgentConfig, AgentCallbacks } from './loop-types.js'
import type { TurnHarness } from './turn-harness.js'
import type { EvidenceTracker } from './evidence.js'
import type { TraceStore } from './trace-store.js'
import { fingerprintToolCall } from './trace-store.js'
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
import { ToolAccumulator } from './tool-accumulator.js'
import { guardLossyToolResult } from './negative-fact-detector.js'
import { getToolStormLevel, type ToolStormLevel } from './trace-store.js'
import { extractTrailingArtifactId, tierToolResult } from './tool-result-tiering.js'
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
  recordToolHistory: (name: string, input: Record<string, unknown>, isError: boolean, content: string, errorClass?: 'environment' | 'exec-failure') => void
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
  /** Late-bound background job registry getter (server replaces it post-construction). */
  getJobs?: () => import('../tools/job-store.js').JobRegistry | undefined
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
  lspManager?: LspManager
  /** T4: late-bound LSP manager getter. */
  getLspManager?: () => LspManager | null
  /** Session-level estimated token count — enables context-pressure-aware truncation. */
  getEstimatedTokens?: () => number
  /** Tool name history — for tool storm detection. */
  getToolNameHistory?: () => string[]
  /** Record a named fingerprint (tool name + fingerprint) */
  recordToolNamedFingerprint?: (fingerprint: string, toolName: string) => void
  /** Capture an agent's departure mark (leave_mark tool) for 主控 to record at close. */
  onLeaveMark?: (mark: import('../tools/types.js').LeaveMarkInput) => void
  /** U6/C1: capture goal decomposition (plan_steps) for the loop's PlanExecutionTrace. */
  onPlanSteps?: (steps: import('../tools/types.js').PlanStepInput[]) => void
  /** Write a constellation milestone when plan_close succeeds with apply=true. */
  onPlanClosed?: (input: import('../tools/types.js').PlanClosedInput) => void
  /** Called when the model explicitly loads a skill via the skill tool. */
  onSkillInvoked?: (name: string) => void
  /** Called when the model explicitly marks a skill as complete via the skill tool. */
  onSkillCompleted?: (name: string) => void
  /** Whether goal mode is active — relaxes doom-loop thresholds when true. */
  isGoalActive?: () => boolean
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
  /** True when any tool returned endTurn: true (e.g. ask_user_question). */
  endTurn?: boolean
}

export class ToolExecutionController {
  private accumulator = new ToolAccumulator()
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

  /**
   * Build the ToolPipelineDeps bag for a single executeToolUse call.
   *
   * Extracted from the two verbatim-duplicated inline blocks (parallel makeDeps
   * closure + sequential pipelineDeps literal) that previously lived in
   * executeBatch. The per-batch mutable state (traceStore/importGraph/etc.)
   * evolves across the loop, so it is passed in as a snapshot each call; the
   * rest is forwarded from this.deps.
   *
   * The abortSignal threading is load-bearing: without it, deps.abortSignal
   * stays undefined, delegate_task passes undefined to coordinator.delegate,
   * and the coordinator abort path becomes dead code — workers hang past the
   * caller timeout and leak detached bash children. (root-cause 2026-06-05)
   */
  private buildDeps(state: {
    traceStore: TraceStore
    importGraph: ImportGraph | null
    lastConflictCheckCount: number
    latestRisk: RiskAssessment
    artifactIdsEvicted: string[]
    artifactIdsAccessed: string[]
    abortSignal: AbortSignal
  }): ToolPipelineDeps {
    return {
      config: this.deps.config,
      cwd: this.deps.cwd,
      harness: this.deps.harness,
      prewarm: this.deps.prewarm,
      evidence: this.deps.evidence,
      traceStore: state.traceStore,
      repairHintTracker: this.deps.repairHintTracker,
      repairPipeline: this.deps.repairPipeline,
      importGraph: state.importGraph,
      meridianIndexer: this.deps.config.meridianIndexer,
      lastConflictCheckCount: state.lastConflictCheckCount,
      trajectory: this.deps.trajectory,
      getDoomLoopLevel: () => this.deps.getDoomLoopLevel(),
      isGoalActive: this.deps.isGoalActive?.() ?? false,
      latestRisk: state.latestRisk,
      sessionTurnCount: this.deps.getSessionTurnCount(),
      sessionId: this.deps.getSessionId(),
      recordToolHistory: (name, input_, isError, content, errorClass) =>
        this.deps.recordToolHistory(name, input_, isError, content, errorClass),
      onLeaveMark: this.deps.onLeaveMark,
      onPlanSteps: this.deps.onPlanSteps,
      onPlanClosed: this.deps.onPlanClosed,
      onSkillInvoked: this.deps.onSkillInvoked,
      onSkillCompleted: this.deps.onSkillCompleted,
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
      jobs: this.deps.getJobs?.(),
      cacheAdvisor: this.deps.cacheAdvisor,
      taskLedger: this.deps.config.taskLedger,
      ownershipLedger: this.deps.config.ownershipLedger,
      verificationSnapshotManager: this.deps.config.verificationSnapshotManager,
      sessionRegistry: this.deps.config.sessionRegistry,
      p3: this.deps.p3,
      immuneHook: this.deps.immuneHook,
      phaseHint: this.deps.getPhaseHint?.(),
      artifactIdsEvicted: state.artifactIdsEvicted,
      artifactIdsAccessed: state.artifactIdsAccessed,
      lspManager: this.deps.lspManager,
      getLspManager: this.deps.getLspManager,
      abortSignal: state.abortSignal,
    }
  }

  async executeBatch(input: ToolExecBatchInput): Promise<ToolExecBatchResult> {
    const toolResults: ContentBlock[] = []
    let checkpointCreatedThisTurn = input.checkpointCreatedThisTurn
    let traceStore = input.traceStore
    let importGraph = input.importGraph
    let endTurn = false
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

        const results = await Promise.all(
          batch.map(({ tu }) => executeToolUse(
            tu,
            this.buildDeps({ traceStore, importGraph, lastConflictCheckCount, latestRisk, artifactIdsEvicted, artifactIdsAccessed, abortSignal: input.abortSignal }),
            input.callbacks,
            input.turn,
            checkpointCreatedThisTurn,
          )),
        )
        for (const result of results) {
          traceStore = result.traceStore
          importGraph = result.importGraph
          lastConflictCheckCount = result.lastConflictCheckCount
          latestRisk = result.latestRisk
          if (result.checkpointCreated) checkpointCreatedThisTurn = true
          if (result.endTurn) endTurn = true
          toolResults.push(result.toolResult)
        }
      } else {
        // Sequential execution for non-safe tools
        const { tu } = indexed[cursor]!
        cursor++

        const result = await executeToolUse(
          tu,
          this.buildDeps({ traceStore, importGraph, lastConflictCheckCount, latestRisk, artifactIdsEvicted, artifactIdsAccessed, abortSignal: input.abortSignal }),
          input.callbacks,
          input.turn,
          checkpointCreatedThisTurn,
        )
        traceStore = result.traceStore
        importGraph = result.importGraph
        lastConflictCheckCount = result.lastConflictCheckCount
        latestRisk = result.latestRisk
        if (result.checkpointCreated) checkpointCreatedThisTurn = true
        if (result.endTurn) endTurn = true
        toolResults.push(result.toolResult)
      }
    }

    // Enforce per-tool-type cumulative budget before aggregate budget.
    const budgetEntries = toolResults
      .map((r, i) => r.type === 'tool_result'
        ? { toolUseId: r.tool_use_id, content: typeof r.content === 'string' ? r.content : '', toolName: input.toolUses[i]?.name ?? '' }
        : null)
      .filter((e): e is NonNullable<typeof e> => e !== null)
    const toolTypeBudgeted = enforceToolTypeBudgets(budgetEntries, this.deps.config.contextWindow)
    for (const entry of toolTypeBudgeted) {
      const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === entry.toolUseId)
      if (idx >= 0) {
        const orig = toolResults[idx]!
        if (orig.type === 'tool_result' && entry.content !== (typeof orig.content === 'string' ? orig.content : '')) {
          toolResults[idx] = { ...orig, content: entry.content }
        }
      }
    }

    // Enforce per-message aggregate budget before adding to conversation.
    const enforced = enforcePerMessageBudget(toolTypeBudgeted, perMessageToolResultBudget(this.deps.config.contextWindow))
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

    // ── Tool Storm Guard: track & collapse consecutive same-type calls ──
    for (let i = 0; i < input.toolUses.length; i++) {
      const tu = input.toolUses[i]!
      const tr = toolResults[i]
      if (tr && tr.type === 'tool_result') {
        const content = typeof tr.content === 'string' ? tr.content : ''
        this.accumulator.record({ toolName: tu.name, toolUseId: tu.id, content, turn: input.turn })
        this.deps.recordToolNamedFingerprint?.(fingerprintToolCall(tu.name, tu.input, 'running'), tu.name)
      }
    }
    if (input.toolUses.length > 0) {
      const lastToolName = input.toolUses[input.toolUses.length - 1]!.name
      const collapse = this.accumulator.tryCollapse(lastToolName)
      if (collapse) {
        for (const collapsedId of collapse.collapsedIds) {
          const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === collapsedId)
          if (idx >= 0) {
            const orig = toolResults[idx]!
            if (orig.type === 'tool_result') {
              toolResults[idx] = { type: 'tool_result', tool_use_id: orig.tool_use_id, content: collapse.summary }
            }
          }
        }
      }
    }

    // Check tool storm level for strategy shift hint
    const toolNames = this.deps.getToolNameHistory?.() ?? []
    const stormLevel = getToolStormLevel(toolNames)
    if (stormLevel === 'storm') {
      const lastTr = toolResults[toolResults.length - 1]
      if (lastTr && lastTr.type === 'tool_result') {
        const existing = typeof lastTr.content === 'string' ? lastTr.content : ''
        toolResults[toolResults.length - 1] = {
          ...lastTr,
          content: existing + '\n\n⚠️ [tool-storm-detected] 同类工具连续调用过多（8+次），请考虑更换策略或汇总已有结果。',
        }
      }
    }

    // ── T10: Tool Result Tiering for 1M+ windows ──
    // Read-path tools are exempt: read_file/read_section have their own cap
    // chain (model-read-cap → artifact wrapping → per-call/turn read budgets →
    // context-pressure truncation) and deliberately keep full source inline so
    // the model can construct exact edit_file old_string matches. Tier-1's
    // head/tail summary on a read result breaks the read→edit workflow.
    const TIERING_EXEMPT_TOOLS = new Set(['read_file', 'read_section'])
    const ctxWin = this.deps.config.contextWindow
    if (ctxWin >= 500_000) {
      for (let i = 0; i < toolResults.length; i++) {
        const tr = toolResults[i]!
        if (tr.type !== 'tool_result') continue
        const tu = input.toolUses[i]
        const toolName = tu?.name ?? 'unknown'
        const content = typeof tr.content === 'string' ? tr.content : ''
        // Read-path tools are exempt from tiering at normal sizes — head/tail
        // summary breaks the read→edit workflow. B2: but when a single read
        // exceeds 300K chars, tiering still fires (content is already on disk
        // via artifact — the model can recover via read_section).
        if (TIERING_EXEMPT_TOOLS.has(toolName) && content.length < 300_000) continue
        const target = typeof tu?.input?.file_path === 'string' ? tu.input.file_path
          : typeof tu?.input?.path === 'string' ? tu.input.path
          : toolName
        // Reuse a tool-level artifact when present — it holds the untruncated
        // original, and saving a second (already budget-truncated) copy both
        // wastes disk and shadows the better artifact.
        const existingArtifactId = extractTrailingArtifactId(content)
        const tiered = await tierToolResult(
          toolName,
          content,
          String(target),
          this.deps.artifactStore,
          ctxWin,
          existingArtifactId,
        )
        if (tiered.tier > 0) {
          toolResults[i] = { ...tr, content: tiered.content }
        }
      }
    }

    // Drain steer guidance ONLY when there is a tool_result to attach it to.
    // onSteerDrain() empties the buffer, so calling it without a valid injection
    // target (e.g. abort broke the loop before any result, or last block is not
    // a tool_result) would discard the guidance. Peek the target first; if absent,
    // leave the buffer intact so the next tool-using turn injects it.
    //
    // Runs AFTER budgets/storm-guard/tiering: those transforms replace content
    // wholesale (tier-2 minimal, budget-summarized), and appending steer text
    // before them silently dropped the user's guidance for large results.
    const lastResult = toolResults.length > 0 ? toolResults[toolResults.length - 1]! : null
    if (lastResult && lastResult.type === 'tool_result') {
      const steerText = input.callbacks.onSteerDrain?.()
      if (steerText) {
        const existing = typeof lastResult.content === 'string' ? lastResult.content : ''
        toolResults[toolResults.length - 1] = { ...lastResult, content: existing + '\n\n' + steerText }
      }
    }

    // ── Lossy Observation Guard: detect negative facts in collapsed/truncated tool results
    // and inject VERIFICATION_REQUIRED marker before the model reads them.
    for (let i = 0; i < toolResults.length; i++) {
      const tr = toolResults[i]!
      if (tr.type === 'tool_result' && typeof tr.content === 'string') {
        const guarded = guardLossyToolResult(tr.content)
        if (guarded !== tr.content) {
          toolResults[i] = { ...tr, content: guarded }
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
          resultContent: result && 'content' in result && typeof result.content === 'string' ? result.content : undefined,
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

    return { checkpointCreated: checkpointCreatedThisTurn, traceStore, importGraph, lastConflictCheckCount, latestRisk, artifactIdsEvicted, artifactIdsAccessed, endTurn: endTurn || undefined }
 }
}
