/**
 * Immune Hook — wires Physarum + Immune layers into the agent loop.
 *
 * Runs as a deferred post-tool immune pass:
 * 1. Registers successful tool fingerprints as normal behavior
 * 2. Collects danger signals from innate layer + Physarum anomaly detection
 * 3. APC dual-signal gating
 * 4. Adaptive immune response (memory lookup or new learning)
 * 5. Feedback to Physarum (quarantine, prune, boost)
 *
 * Physarum file→file sequence learning is handled by
 * hooks/physarum-file-access-hook.ts so this immune pass does not feed
 * tool-name nodes into the file topology graph.
 */

import { InnateLayer } from './immune-innate.js'
import { ApcAggregator } from './immune-apc.js'
import { ImmuneAdaptiveLayer } from './immune-adaptive.js'
import type { DangerSignal, ImmuneMemory, ImmuneResponse } from './immune-types.js'
import type { PhysarumEngine } from '../repo/physarum-engine.js'
import type { StigmergyStore } from '../context/stigmergy.js'
import type { DoomLoopLevel } from './trace-store.js'
import type { HealthSignal } from './trajectory-health.js'
import type { MistakeNotebook } from './mistake-notebook.js'
import { generateImmuneContext, type ImmuneContextHint } from './immune-context.js'

export interface ImmuneHookDeps {
  physarum: PhysarumEngine
  stigmergy?: StigmergyStore
  notebook?: MistakeNotebook
}

export interface ImmuneHookContext {
  toolName: string
  fingerprint: string
  turn: number
  doomLevel: DoomLoopLevel
  targetFile?: string
  tokenUsage?: number
  trajectoryHealth?: HealthSignal
  /** When true, tool result was an error — innate layer skips fingerprint for tool_repeat. */
  isError?: boolean
}

export interface ImmuneHookResult {
  activated: boolean
  response?: ImmuneResponse
  signals: DangerSignal[]
  contextHint?: ImmuneContextHint
}

const BATCH_EVOLVE_INTERVAL = 10
const UBIQUITY_INTERVAL = 50

export class ImmuneHook {
  readonly innate = new InnateLayer()
  readonly apc = new ApcAggregator()
  readonly adaptive = new ImmuneAdaptiveLayer()
  private lastBatchTurn = 0
  private lastUbiquityTurn = 0

  constructor(private deps: ImmuneHookDeps) {}

  getPhysarum(): PhysarumEngine { return this.deps.physarum }

  /** Main entry point — called after each tool execution */
  run(ctx: ImmuneHookContext): ImmuneHookResult {
    try {
      // 0. Register normal behavior for negative selection. File-sequence
      // topology learning is handled by the dedicated physarum-file-access hook;
      // targetFile here may be a directory, command preview, or tool fallback.
      if (ctx.targetFile) {
        this.adaptive.registerNormal(ctx.fingerprint)
      }

      // 1. Innate layer check
      const innateSignals = this.innate.check({
        toolName: ctx.toolName,
        fingerprint: ctx.fingerprint,
        turn: ctx.turn,
        tokenUsage: ctx.tokenUsage,
        isError: ctx.isError,
      })

      // 2. Trajectory health as danger signal
      if (ctx.trajectoryHealth === 'escalate') {
        innateSignals.push({
          kind: 'prediction_error', severity: 0.9,
          turn: ctx.turn, source: 'atropos',
        })
      } else if (ctx.trajectoryHealth === 'degrading') {
        innateSignals.push({
          kind: 'prediction_error', severity: 0.5,
          turn: ctx.turn, source: 'atropos',
        })
      }

      // 3. Physarum anomaly detection
      const graphSignal = this.deps.physarum.detectAnomaly()
      if (graphSignal) {
        innateSignals.push({
          kind: 'graph_anomaly',
          severity: graphSignal.severity,
          turn: ctx.turn,
          source: graphSignal.source,
        })
      }

      // 4. Collect all signals into APC
      for (const signal of innateSignals) {
        this.apc.collect(signal)
      }

      // 5. APC dual-signal gating
      const patternMatch = ctx.doomLevel !== 'none'
      const mistakeCount = Array.from(this.repairFailCounts.values()).reduce((s, c) => s + c, 0)
      const activation = this.apc.evaluate(patternMatch, ctx.turn, mistakeCount)

      if (!activation.shouldActivate) {
        this.maybeRunMaintenance(ctx.turn)
        return { activated: false, signals: innateSignals }
      }

      // 6. Adaptive immune response
      const memory = this.adaptive.lookup(ctx.fingerprint)
      let response: ImmuneResponse

      // ── Immune → Context: generate hint for model ──
      let contextHint: ImmuneContextHint | undefined
      if (this.deps.notebook) {
        const hint = generateImmuneContext(activation, this.deps.notebook, ctx.turn)
        if (hint) contextHint = hint
      }

      if (memory) {
        // Secondary response: fast repair from memory
        response = this.adaptive.fastRepair(memory)
        memory.hitCount++
        memory.lastHit = ctx.turn
      } else {
        // Primary response: map APC three-tier decision
        const tier = activation.responseType ?? 'deposit_warning'
        if (tier === 'quarantine') {
          response = { type: 'quarantine', targetFile: ctx.targetFile, duration: 20 }
        } else {
          // prune_toxic lacks toxicEdges data source — fallback to deposit_warning
          // until Physarum exposes edge-level anomaly queries
          response = { type: 'deposit_warning', targetFile: ctx.targetFile }
        }
      }

      // 7. Apply response to Physarum
      this.applyResponse(response)

      // 8. Deposit pheromone warning if stigmergy available (skip for quarantine — already frozen)
      if (this.deps.stigmergy && ctx.targetFile && response.type !== 'quarantine') {
        // Fire-and-forget: pheromone persistence failures (e.g. unwritable cwd
        // in tests) must not break immune response. Without .catch this becomes
        // an unhandled rejection that surfaces unpredictably depending on
        // event-loop timing.
        this.deps.stigmergy.deposit({
          path: ctx.targetFile,
          signal: 'fragile',
          strength: 0.8,
          halfLifeMs: 3600_000,
          context: 'immune-response',
        }).catch(() => { /* deposit is best-effort */ })
      }

      this.maybeRunMaintenance(ctx.turn)
      return { activated: true, response, signals: innateSignals, contextHint }
    } catch (error) {
      // Immune failure must never crash the agent loop, but it also must not be
      // silent: surface the degraded immune state as a danger signal so APC state
      // and telemetry preserve anomaly visibility.
      const message = error instanceof Error ? error.message : String(error)
      const signal: DangerSignal = {
        kind: 'immune_hook_error',
        severity: 0.8,
        turn: ctx.turn,
        source: 'immune-hook',
        context: message.slice(0, 200),
      }
      try { this.apc.collect(signal) } catch { /* keep the fail-open boundary */ }
      return { activated: false, signals: [signal] }
    }
  }

  /** Record successful repair (called externally after repair pipeline succeeds) */
  recordRepairSuccess(fingerprint: string, response: ImmuneResponse, turn: number): void {
    this.adaptive.recordSuccess(fingerprint, response, turn)
    this.repairFailCounts.delete(fingerprint)
  }

  /** Track consecutive failures per fingerprint */
  private repairFailCounts = new Map<string, number>()

  /** Record failed repair — injects repair_exhaustion signal after 3 consecutive failures */
  recordRepairFailure(fingerprint: string, turn: number): void {
    this.adaptive.recordFailure(fingerprint)
    const count = (this.repairFailCounts.get(fingerprint) ?? 0) + 1
    this.repairFailCounts.set(fingerprint, count)
    if (count >= 3) {
      this.injectSignal({
        kind: 'repair_exhaustion',
        severity: 0.8,
        turn,
        source: 'immune-adaptive',
        context: `fingerprint ${fingerprint} failed ${count} consecutive repairs`,
      })
      this.repairFailCounts.delete(fingerprint)
    }
  }

  /** Inject external danger signal (e.g., from compaction failure, sycophancy trap, prompt injection detection) */
  injectSignal(signal: DangerSignal): void {
    this.apc.collect(signal)
  }

  private applyResponse(response: ImmuneResponse): void {
    switch (response.type) {
      case 'quarantine':
        if (response.targetFile) {
          this.deps.physarum.freezeNode(response.targetFile, response.duration ?? 20)
        }
        break
      case 'prune_toxic':
        if (response.toxicEdges) {
          this.deps.physarum.forcePrune(response.toxicEdges)
        }
        break
      case 'boost_healthy':
        if (response.healthyEdges) {
          const files = response.healthyEdges.flatMap(e => [e.fileA, e.fileB])
          this.deps.physarum.boostEdges(files, 0.5)
        }
        break
      case 'deposit_warning':
        // Already handled via stigmergy above
        break
    }
  }

  private maybeRunMaintenance(turn: number): void {
    // Batch evolve (cold path decay + prune)
    if (turn - this.lastBatchTurn >= BATCH_EVOLVE_INTERVAL) {
      this.deps.physarum.batchEvolve(turn)
      this.lastBatchTurn = turn
    }

    // Ubiquity penalty (less frequent)
    if (turn - this.lastUbiquityTurn >= UBIQUITY_INTERVAL) {
      this.deps.physarum.applyUbiquityPenalty()
      this.lastUbiquityTurn = turn
    }

    // Adaptive memory decay
    this.adaptive.decay(turn)
  }

  /** Get current danger level for monitoring */
  getDangerLevel(turn: number): number {
    return this.apc.getDangerLevel(turn)
  }

  /** Export immune memories for persistence */
  exportMemories() { return this.adaptive.export() }

  /** Import immune memories from persistence (cross-session secondary response) */
  importMemories(memories: ImmuneMemory[]): void {
    this.adaptive.import(memories)
  }
}

export function createImmuneHook(deps: ImmuneHookDeps): ImmuneHook {
  return new ImmuneHook(deps)
}
