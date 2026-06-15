import type { ReasoningEffort } from './auto-reasoning.js'
import type { Sensorium, StrategyProfile } from './sensorium.js'
import type { StarPhaseContext } from './star-event.js'
import { detectRigidity, shouldTriggerElmRelease } from './vigor.js'
import type { VigorState } from './vigor.js'

export interface StarPhaseContextInput {
  turn: number
  maxTurns: number
  recentTools: string[]
  shouldEscalate: boolean
  hasEnteredHighComplexity: boolean
}

export interface ThetaTelemetrySnapshot {
  inFlight: boolean
  lastReason: string | null
  lastDurationMs: number | null
  lastErrorCount: number
  lastTimedOut: boolean
  requestedCount: number
}

export interface HealthTelemetrySnapshot {
  rigidity: boolean
  elmDue: boolean
}

export interface PerceptionTelemetrySnapshot extends Sensorium {
  ts: number
  turn: number
  phase: string
  strategy: {
    reasoningEffort: ReasoningEffort
    shouldEscalate: boolean
    thetaInterval: number
  }
  vigor: {
    tonic: number
    phasic: number
    curiosity: number
    vigor: number
    variability: number
  }
  health: HealthTelemetrySnapshot
  theta: ThetaTelemetrySnapshot
  gitChangeRate: number
  prefixDrift: boolean
}

export interface TelemetryInput {
  ts: number
  turn: number
  phase: string
  sensorium: Sensorium
  strategy: StrategyProfile
  vigor: VigorState
  theta: ThetaTelemetrySnapshot
  gitChangeRate: number
  prefixDrift: boolean
  /** elmDue 冷却的上次触发轮次（per-session 持有）。省略 = 从未触发。 */
  lastElmReleaseTurn?: number
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function applyProviderHealth(sensorium: Sensorium, degradationRatio: number): Sensorium {
  const ratio = clamp01(degradationRatio)
  if (ratio <= 0) return sensorium
  return {
    ...sensorium,
    stability: round(clamp01(sensorium.stability * (1 - 0.3 * ratio))),
  }
}

export function adaptThetaInterval(baseInterval: number, gitChangeRate: number): number {
  const gitMod = 1 - clamp01(gitChangeRate) * 0.5
  return Math.max(2, Math.round(baseInterval * gitMod))
}

export function buildStarPhaseContext(input: StarPhaseContextInput): StarPhaseContext {
  return {
    turn: input.turn,
    isWriting: input.recentTools.some(t => t === 'write_file' || t === 'edit_file'),
    isRunningTests: input.recentTools.some(t => t === 'run_tests'),
    isFinalTurn: input.turn >= input.maxTurns - 1,
    shouldEscalate: input.shouldEscalate,
    hasEnteredHighComplexity: input.hasEnteredHighComplexity,
  }
}

export const ELM_COOLDOWN_TURNS = 5

/**
 * 计算健康遥测。elmDue 冷却为**纯函数**：调用方传入上次触发的轮次
 * （per-session 持有，见 TurnPerceptionController.lastElmReleaseTurn），
 * 本函数不持有任何模块级状态——避免并行子代理共享同一进程时冷却态相互污染。
 *
 * 契约：当返回的 elmDue 为 true 时，调用方应把自己持有的 lastElmReleaseTurn
 * 更新为本轮 currentTurn，以驱动下一轮的冷却判定。
 *
 * - currentTurn 省略 → 不施加冷却（裸 elm 判定，向后兼容）。
 * - lastElmReleaseTurn 省略 → 视为从未触发（-Infinity），首次必触发。
 */
export function buildHealthTelemetry(
  vigor: VigorState,
  currentTurn?: number,
  lastElmReleaseTurn = -Infinity,
): HealthTelemetrySnapshot {
  const rawElmDue = shouldTriggerElmRelease(vigor)
  const elmDue = currentTurn == null
    ? rawElmDue
    : rawElmDue && (currentTurn - lastElmReleaseTurn >= ELM_COOLDOWN_TURNS)
  return {
    rigidity: detectRigidity(vigor.history),
    elmDue,
  }
}

export function buildTelemetrySnapshot(input: TelemetryInput): PerceptionTelemetrySnapshot {
  return {
    ts: input.ts,
    turn: input.turn,
    phase: input.phase,
    ...input.sensorium,
    strategy: {
      reasoningEffort: input.strategy.reasoningEffort,
      shouldEscalate: input.strategy.shouldEscalate,
      thetaInterval: input.strategy.thetaCycleInterval,
    },
    vigor: {
      tonic: input.vigor.tonic,
      phasic: input.vigor.phasic,
      curiosity: input.vigor.curiosity,
      vigor: input.vigor.vigor,
      variability: input.vigor.variability,
    },
    health: buildHealthTelemetry(input.vigor, input.turn, input.lastElmReleaseTurn),
    theta: input.theta,
    gitChangeRate: input.gitChangeRate,
    prefixDrift: input.prefixDrift,
  }
}
