import type { ContentBlock } from '../api/types.js'
import type { AgentConfig, AgentCallbacks } from './loop.js'
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
import {
  getInterventionLevel,
  recordPrediction,
  shouldTippingPointReset,
  resetAccumulator,
  adjustReasoningEffort,
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
  checkpointCreated: boolean
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  latestRisk: RiskAssessment
}

export class ToolExecutionController {
  constructor(private deps: ToolExecutionDeps) {}

  async executeBatch(input: ToolExecBatchInput): Promise<ToolExecBatchResult> {
    const toolResults: ContentBlock[] = []
    let checkpointCreatedThisTurn = input.checkpointCreatedThisTurn
    let traceStore = input.traceStore
    let importGraph = input.importGraph
    let lastConflictCheckCount = input.lastConflictCheckCount
    let latestRisk = input.latestRisk

    for (const tu of input.toolUses) {
      if (input.abortSignal.aborted) break

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
      }

      const result = await executeToolUse(tu, pipelineDeps, input.callbacks, input.turn, checkpointCreatedThisTurn)
      traceStore = result.traceStore
      importGraph = result.importGraph
      lastConflictCheckCount = result.lastConflictCheckCount
      latestRisk = result.latestRisk
      if (result.checkpointCreated) checkpointCreatedThisTurn = true
      toolResults.push(result.toolResult)
    }

    const steerText = input.callbacks.onSteerDrain?.()
    if (steerText && toolResults.length > 0) {
      const lastResult = toolResults[toolResults.length - 1]!
      if (lastResult.type === 'tool_result') {
        const existing = typeof lastResult.content === 'string' ? lastResult.content : ''
        toolResults[toolResults.length - 1] = { ...lastResult, content: existing + '\n\n' + steerText }
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
          },
        ),
        {
          name: tu.name,
          success: !(result && 'is_error' in result && result.is_error === true),
          isError: result && 'is_error' in result ? result.is_error === true : false,
          target,
        },
      )
    }

    if (shouldTippingPointReset(this.deps.getPredictionAccumulator())) {
      this.deps.setPredictionAccumulator(resetAccumulator(this.deps.getPredictionAccumulator()))
      this.deps.contextInjection.clearCerebellarHint()
    }
    if (this.deps.getAutoReasoning() && this.deps.getReasoningEffort()) {
      const newEffort = adjustReasoningEffort(this.deps.getReasoningEffort()!, level)
      this.deps.setClientReasoningEffort(newEffort)
    }

    return { checkpointCreated: checkpointCreatedThisTurn, traceStore, importGraph, lastConflictCheckCount, latestRisk }
  }
}
