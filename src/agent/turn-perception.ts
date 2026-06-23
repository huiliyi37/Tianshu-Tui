import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { PrefixFingerprint } from '../prompt/fingerprint.js'
import type { Pheromone } from '../context/stigmergy.js'
import type { PressureResult } from '../context/pressure-monitor.js'
import type { EvidenceState } from './evidence.js'
import type { PredictionAccumulator } from './prediction-error.js'
import type { RuntimeHookPipeline, RuntimeHookSnapshot } from './runtime-hooks.js'
import { createRuntimeHookContext } from './runtime-hooks.js'
import type { Sensorium, SensoriumInput, StrategyProfile } from './sensorium.js'
import { adaptThetaInterval, buildStarPhaseContext, buildTelemetrySnapshot } from './perception.js'
import type { ThetaTelemetrySnapshot } from './perception.js'
import { createStarEvent } from './star-event.js'
import { routeRoutineEffort } from './effort-routing.js'
import type { StarEvent, ThetaState } from './star-event.js'
import type { VigorState } from './vigor.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import type { SensoriumEntry } from './retrospect.js'
import { getDoomLoopLevel, type TraceStore } from './trace-store.js'

export interface TurnPerceptionDeps {
  cwd: string
  maxTurns: number
  runtimeHooks: RuntimeHookPipeline
  telemetryWriter: TelemetryWriter
  getRuntimeSnapshot(extra?: Partial<RuntimeHookSnapshot>): RuntimeHookSnapshot
  getProviderDegradationRatio(): number
  addUserMessage(message: string): void
  requestThetaCheck(reason: string): void
  setReasoningEffort(effort: StrategyProfile['reasoningEffort']): void
  getFingerprint(): PrefixFingerprint
}

export interface PerceptionInput {
  turn: number
  estimatedTokens: number
  pressureResult: PressureResult
  evidenceState: EvidenceState
  predictionAccumulator: PredictionAccumulator
  recentToolHistory: ToolHistoryEntry[]
  loadedPheromones: Pheromone[]
  traceStore: TraceStore
  gitChangeRate: number
  fsEventRate?: number
  sensorium: Sensorium | null
  strategy: StrategyProfile | null
  vigor: VigorState
  thetaState: ThetaState
  thetaTelemetry: Omit<ThetaTelemetrySnapshot, 'inFlight'>
  thetaCheckInFlight: boolean
  baselineFingerprint: PrefixFingerprint | null
}

export interface PerceptionResult {
  sensorium: Sensorium
  strategy: StrategyProfile
  vigor: VigorState
  thetaState: ThetaState
  event: StarEvent
  sensoriumInput: SensoriumInput
}

const MAX_SNAPSHOTS = 100

export class TurnPerceptionController {
  private sensoriumSnapshots: SensoriumEntry[] = []
  private hasEnteredHighComplexity = false
  private currentPhase = 'unknown'
  /** elmDue 冷却的上次触发轮次（per-session，避免并行子代理共享模块级全局态）。 */
  private lastElmReleaseTurn = -Infinity

  constructor(private deps: TurnPerceptionDeps) {}

  async perceive(
    input: PerceptionInput,
    effects: {
      emitPhaseChange(phase: string, detail?: { tool?: string; reason?: string; suggestion?: string }): void
      /** R4 — surface a structured course-correction (kick-hook fires in preTurn). */
      emitDecisionShift?(shift: import('./loop-types.js').DecisionShift): void
    },
  ): Promise<PerceptionResult> {
    const sensoriumInput: SensoriumInput = {
      predictionAcc: input.predictionAccumulator,
      pressureResult: input.pressureResult,
      evidenceState: {
        filesModified: input.evidenceState.filesModified.size,
        verifiedCount: input.evidenceState.verifications.filter(v => v.status === 'passed').length,
      },
      toolCallHistory: input.recentToolHistory.map(h => h.tool),
      pheromones: input.loadedPheromones,
      doomLevel: getDoomLoopLevel(input.traceStore.toolFingerprints),
      gitChangeRate: input.gitChangeRate,
      fsEventRate: input.fsEventRate,
    }

    let nextSensorium = input.sensorium
    let nextStrategy = input.strategy
    let nextVigor = input.vigor

    await this.deps.runtimeHooks.runPreTurn(createRuntimeHookContext(this.deps.getRuntimeSnapshot({
      sensoriumInput,
      providerDegradationRatio: this.deps.getProviderDegradationRatio(),
    }), {
      setSensorium: sensorium => { nextSensorium = sensorium },
      setStrategy: strategy => { nextStrategy = strategy },
      injectUserMessage: message => { this.deps.addUserMessage(message) },
      emitPhaseChange: (phase, detail) => { effects.emitPhaseChange(phase, detail) },
      emitDecisionShift: shift => { effects.emitDecisionShift?.(shift) },
    }))

    if (!nextSensorium || !nextStrategy) {
      throw new Error('Perception runtime hook did not produce sensorium and strategy')
    }

    let currentStrategy = nextStrategy
    await this.deps.runtimeHooks.runAfterPerception(createRuntimeHookContext(this.deps.getRuntimeSnapshot({
      sensorium: nextSensorium,
      strategy: currentStrategy,
      vigor: nextVigor,
    }), {
      setStrategy: strategy => { currentStrategy = strategy },
      setVigor: vigor => { nextVigor = vigor },
      requestThetaCheck: reason => { this.deps.requestThetaCheck(reason) },
    }))
    nextStrategy = currentStrategy

    if (nextSensorium.complexity > 0.5) {
      this.hasEnteredHighComplexity = true
    }

    // Phase 2A effort routing (opt-in via RIVET_EFFORT_ROUTING=1, off by default):
    // step effort down one tier on routine, on-track turns. Floor is enforced
    // downstream in ReasoningEffortController.set().
    this.deps.setReasoningEffort(routeRoutineEffort(nextStrategy.reasoningEffort, {
      complexity: nextSensorium.complexity,
      momentum: nextSensorium.momentum,
      confidence: nextSensorium.confidence,
    }))
    const thetaState = {
      ...input.thetaState,
      interval: adaptThetaInterval(nextStrategy.thetaCycleInterval, input.gitChangeRate),
    }

    const recentTools = input.recentToolHistory.map(h => h.tool)
    const starCtx = buildStarPhaseContext({
      turn: input.turn,
      maxTurns: this.deps.maxTurns,
      recentTools,
      shouldEscalate: nextStrategy.shouldEscalate,
      hasEnteredHighComplexity: this.hasEnteredHighComplexity,
    })
    const event = createStarEvent(nextSensorium, starCtx)
    this.currentPhase = event.phase
    effects.emitPhaseChange(event.phase, {
      tool: event.glyph,
      suggestion: event.label,
    })

    this.recordTelemetry({
      input,
      event,
      sensorium: nextSensorium,
      strategy: nextStrategy,
      vigor: nextVigor,
    })

    return {
      sensorium: nextSensorium,
      strategy: nextStrategy,
      vigor: nextVigor,
      thetaState,
      event,
      sensoriumInput,
    }
  }

  getSnapshots(): SensoriumEntry[] {
    return this.sensoriumSnapshots
  }

  getCurrentPhase(): string {
    return this.currentPhase
  }

  reset(): void {
    this.sensoriumSnapshots = []
    this.hasEnteredHighComplexity = false
    this.currentPhase = 'unknown'
    this.lastElmReleaseTurn = -Infinity
  }

  private recordTelemetry(input: {
    input: PerceptionInput
    event: StarEvent
    sensorium: Sensorium
    strategy: StrategyProfile
    vigor: VigorState
  }): void {
    const currentFP = this.deps.getFingerprint()
    const driftEvent = input.input.baselineFingerprint
      ? (currentFP.combinedSha256 !== input.input.baselineFingerprint.combinedSha256)
      : false
    const telemetrySnapshot = buildTelemetrySnapshot({
      ts: Date.now(),
      turn: input.input.turn,
      phase: input.event.phase,
      sensorium: input.sensorium,
      strategy: input.strategy,
      vigor: input.vigor,
      theta: {
        inFlight: input.input.thetaCheckInFlight,
        lastReason: input.input.thetaTelemetry.lastReason,
        lastDurationMs: input.input.thetaTelemetry.lastDurationMs,
        lastErrorCount: input.input.thetaTelemetry.lastErrorCount,
        lastTimedOut: input.input.thetaTelemetry.lastTimedOut,
        requestedCount: input.input.thetaTelemetry.requestedCount,
      },
      gitChangeRate: input.input.gitChangeRate,
      prefixDrift: driftEvent,
      lastElmReleaseTurn: this.lastElmReleaseTurn,
    })
    // 契约：elmDue 触发即记录本轮，驱动 per-session 冷却（见 buildHealthTelemetry）。
    if (telemetrySnapshot.health.elmDue) {
      this.lastElmReleaseTurn = input.input.turn
    }

    this.deps.telemetryWriter.write(telemetrySnapshot)
    this.sensoriumSnapshots.push({
      ts: telemetrySnapshot.ts,
      turn: telemetrySnapshot.turn,
      phase: telemetrySnapshot.phase,
      momentum: telemetrySnapshot.momentum,
      pressure: telemetrySnapshot.pressure,
      confidence: telemetrySnapshot.confidence,
      complexity: telemetrySnapshot.complexity,
      freshness: telemetrySnapshot.freshness,
      stability: telemetrySnapshot.stability,
      strategy: telemetrySnapshot.strategy,
      gitChangeRate: telemetrySnapshot.gitChangeRate,
    })
    if (this.sensoriumSnapshots.length > MAX_SNAPSHOTS) {
      this.sensoriumSnapshots.shift()
    }
  }
}
