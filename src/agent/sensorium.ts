import type { ReasoningEffort } from './auto-reasoning.js'
import type { PressureResult } from '../context/pressure-monitor.js'
import type { EvidenceState } from './evidence.js'
import type { DoomLoopLevel } from './trace-store.js'

// ─── Pheromone reference (minimal type for SensoriumInput) ──────────

export type PheromoneSignal =
  | 'fragile'
  | 'well-tested'
  | 'performance-critical'
  | 'refactor-candidate'
  | 'dead-end'
  | 'entry-point'
  | 'coupling-hub'
  // ── CVM 阳面：美德信号（五常映射）──
  // 万物负阴而抱阳。纯阴则死，纯阳则混沌。
  // 五常 → AI agent 美德：仁=质疑, 义=验证, 礼=边界, 智=觉察, 信=忠cache
  | 'independent-judgment'
  | 'proactive-verification'
  | 'boundary-respect'
  | 'strategic-awareness'
  | 'cache-loyalty'
  | 'obligation-fulfilled'

export interface PheromoneRef {
  path: string
  signal: PheromoneSignal
  strength: number
  depositedAt: number
  halfLife: number
  context?: string
}

// ─── Sensorium ──────────────────────────────────────────────────────

/**
 * 6-dimension situational awareness vector.
 * All dimensions are 0.0–1.0 continuous values.
 * Computed purely from existing monitor outputs — zero LLM overhead.
 */
export interface Sensorium {
  /** Prediction accuracy momentum: consecutiveCorrect / windowSize */
  momentum: number
  /** Context pressure: estimatedTokens / contextWindow */
  pressure: number
  /** Verification confidence: verified_count / modified_count (or 1.0 if no changes) */
  confidence: number
  /** Tool diversity: unique tools / total calls in sliding window */
  complexity: number
  /** Cross-session file familiarity: avg pheromone strength (default 0.5) */
  freshness: number
  /** Strategy stability: inverse of doom loop severity */
  stability: number
}

/**
 * Raw monitor data fed into computeSensorium.
 * All fields are pure data snapshots — no live references to mutable objects.
 */
export interface SensoriumInput {
  predictionAcc: {
    windowSize: number
    predictions: boolean[]
    consecutiveCorrect: number
  }
  pressureResult: PressureResult
  evidenceState: {
    filesModified: number
    verifiedCount: number
  }
  /** Tool names from the most recent sliding window (max 5) */
  toolCallHistory: string[]
  pheromones: PheromoneRef[]
  doomLevel: DoomLoopLevel
  /** Git file change rate (0-1), blended into freshness.
   *  Undefined when git is unavailable — freshness falls back to pure pheromone mode. */
  gitChangeRate?: number
  /** Filesystem event rate (0-1) from fs-watcher — 原则③ external Zeitgeber */
  fsEventRate?: number
}

// ─── Strategy Profile ───────────────────────────────────────────────

/**
 * Harness-layer strategy decisions derived from Sensorium.
 * Drives reasoning effort, exploration breadth, commit gating,
 * model escalation, and cross-file consistency check cadence.
 */
export interface StrategyProfile {
  reasoningEffort: ReasoningEffort
  explorationBreadth: number
  commitThreshold: number
  shouldEscalate: boolean
  thetaCycleInterval: number
}

// ─── Dimension Computers ────────────────────────────────────────────

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function computeMomentum(acc: SensoriumInput['predictionAcc']): number {
  if (acc.windowSize <= 0) return 0
  return clamp(acc.consecutiveCorrect / acc.windowSize)
}

function computePressure(pr: PressureResult): number {
  return clamp(pr.ratio)
}

function computeConfidence(evidence: SensoriumInput['evidenceState']): number {
  if (evidence.filesModified <= 0) return 1.0
  return clamp(evidence.verifiedCount / evidence.filesModified)
}

function computeComplexity(toolHistory: string[]): number {
  if (toolHistory.length === 0) return 0
  const unique = new Set(toolHistory).size
  return clamp(unique / toolHistory.length)
}

function computeFreshness(
  pheromones: PheromoneRef[],
  gitChangeRate?: number,
  fsEventRate?: number,
): number {
  // Base: pheromone signal (cross-session memory). Default 0.5 for unknown codebase.
  const pheromoneAvg = pheromones.length === 0
    ? 0.5
    : clamp(pheromones.reduce((sum, p) => sum + p.strength, 0) / pheromones.length)

  // Dimension weights: pheromone is long-term memory, git/Zeitgeber is medium-term, fs is real-time
  let result = pheromoneAvg
  let weight = 1.0

  if (gitChangeRate !== undefined && gitChangeRate >= 0) {
    // Git Zeitgeber: 70% pheromone + 30% git (inverse — high change = low freshness)
    result = 0.7 * result + 0.3 * (1 - gitChangeRate)
    weight = 1.0
  }

  if (fsEventRate !== undefined && fsEventRate >= 0) {
    // FS Zeitgeber: blend in with diminishing weight
    // 60% current + 40% fs-inverse. Git and fs are correlated but not identical —
    // fs captures file watchers, formatters, auto-saves that git doesn't see.
    result = 0.6 * result + 0.4 * (1 - fsEventRate)
  }

  return clamp(result)
}

function computeStability(doomLevel: DoomLoopLevel): number {
  switch (doomLevel) {
    case 'none': return 1.0
    case 'warn': return 0.6
    case 'blocked': return 0.2
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Compute a 6-dimension Sensorium snapshot from raw monitor data.
 *
 * Pure function — no I/O, no LLM, no side effects. Expected to run in <1ms.
 * All dimensions are clamped to [0, 1].
 */
export function computeSensorium(input: SensoriumInput): Sensorium {
  return {
    momentum: computeMomentum(input.predictionAcc),
    pressure: computePressure(input.pressureResult),
    confidence: computeConfidence(input.evidenceState),
    complexity: computeComplexity(input.toolCallHistory),
    freshness: computeFreshness(input.pheromones, input.gitChangeRate, input.fsEventRate),
    stability: computeStability(input.doomLevel),
  }
}

/**
 * Derive harness-layer strategy profile from a Sensorium snapshot.
 *
 * Rules (from design doc):
 * - reasoningEffort: complexity > 0.7 → high; momentum > 0.8 → low; else medium
 * - explorationBreadth: stability < 0.3 → 0.9 (wide search); else 0.3 (focused)
 * - commitThreshold: pressure > 0.7 → 0.9 (cautious); else 0.6 (normal)
 * - shouldEscalate: confidence < 0.3 && momentum < 0.2 (request stronger model)
 * - thetaCycleInterval: complexity > 0.5 → 3 (frequent); else 7 (relaxed)
 *
 * Pure function — deterministic, no side effects.
 */
export function computeStrategy(s: Sensorium): StrategyProfile {
  let reasoningEffort: ReasoningEffort
  if (s.complexity > 0.7) {
    reasoningEffort = 'high'
  } else if (s.momentum > 0.8) {
    reasoningEffort = 'low'
  } else {
    reasoningEffort = 'medium'
  }

  return {
    reasoningEffort,
    explorationBreadth: s.stability < 0.3 ? 0.9 : 0.3,
    commitThreshold: s.pressure > 0.7 ? 0.9 : 0.6,
    shouldEscalate: s.confidence < 0.3 && s.momentum < 0.2,
    thetaCycleInterval: s.complexity > 0.5 ? 3 : 7,
  }
}
