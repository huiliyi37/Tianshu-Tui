import type { ReasoningEffort } from './auto-reasoning.js'
import type { PressureResult } from '../context/pressure-monitor.js'
import type { EvidenceState } from './evidence.js'
import type { DoomLoopLevel, ToolStormLevel } from './trace-store.js'

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
  /** 多维压力：上下文填充 (0.50) + 验证债 (0.30) + CVM 开销 (0.15) + 增速 (0.05) */
  pressure: number
  /** Verification coverage ratio: verified_count / modified_count.
   *  Returns 1.0 when no files modified (vacuously true — 0/0 = all verified).
   *  This is a coverage metric, NOT general confidence.
   *  In the cognitive-mirror it is rendered as `verification_coverage`. */
  confidence: number
  /** Tool diversity: unique tools / total calls in sliding window */
  complexity: number
  /** Cross-session file familiarity: avg pheromone strength (default 0.5) */
  freshness: number
  /** 连续稳定性：doom (0.40) + prediction (0.25) + diversity (0.20) + verification (0.15) */
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

/**
 * 多维压力感知 — 不止上下文窗口。
 *
 * 压力是复合信号：上下文快满了是压力，改动未验证也是压力，
 * CVM 自监管开销同样是压力。单一维度的 pressure=0 会让 agent
 * 误以为"一切从容"，而实际上验证债正在堆积。
 *
 * 权重设计：上下文填充仍是主导信号（0.50），验证债（0.30）是
 * 第二信号——未验证的改动越多，出错代价越大。CVM 开销（0.15）
 * 和上下文增长速度（0.05）作为辅助信号。
 */
function computePressure(
  pr: PressureResult,
  evidence: SensoriumInput['evidenceState'],
): number {
  const contextPressure = clamp(pr.ratio)
  const verificationDebt = evidence.filesModified > 0
    ? clamp((evidence.filesModified - evidence.verifiedCount) / Math.max(evidence.filesModified, 5))
    : 0
  const cvmOverhead = clamp(pr.cvmOverheadRatio)
  const growthPenalty = clamp(Math.max(0, pr.growthRate))

  return clamp(
    0.50 * contextPressure +
    0.30 * verificationDebt +
    0.15 * cvmOverhead +
    0.05 * growthPenalty,
  )
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

/**
 * 连续稳定性感知 — 不止 doom loop 三元检测。
 *
 * 旧设计只有三个离散值 {1.0, 0.6, 0.2}，正常会话始终显示 1.00，
 * 对 agent 而言是零信号维度。稳定性应该是连续的健康指标。
 *
 * 四信号融合：
 *   doomBase (0.40) — doom loop 等级，最强信号
 *   predictionRate (0.25) — 预测准确率，模型对世界的理解是否在线
 *   diversity (0.20) — 工具多样性，反向指标：重复调用同一工具暗示陷入循环
 *   verificationCoverage (0.15) — 已验证改动比例，验证覆盖率越高越稳定
 *
 * 正常会话典型值 0.75-0.95，warn 附近 ~0.45-0.55，blocked ~0.10-0.25。
 */
function computeStability(
  doomLevel: DoomLoopLevel,
  predictionAcc: SensoriumInput['predictionAcc'],
  toolCallHistory: string[],
  evidence: SensoriumInput['evidenceState'],
): number {
  // doom base: continuous mapping from ternary doom level
  const doomBase: number = doomLevel === 'none' ? 0.90
    : doomLevel === 'warn' ? 0.50
    : 0.10

  // prediction accuracy: how often does the model correctly predict outcomes?
  const predictionRate = predictionAcc.predictions.length > 0
    ? predictionAcc.predictions.filter(Boolean).length / predictionAcc.predictions.length
    : 0.5

  // tool diversity: inverse of repetition — stuck agents repeat the same tool
  const diversity = toolCallHistory.length > 0
    ? new Set(toolCallHistory).size / toolCallHistory.length
    : 0.5

  // verification coverage: are we verifying what we change?
  const verificationCoverage = evidence.filesModified > 0
    ? clamp(evidence.verifiedCount / evidence.filesModified)
    : 1.0

  return clamp(
    0.40 * doomBase +
    0.25 * predictionRate +
    0.20 * diversity +
    0.15 * verificationCoverage,
  )
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
    pressure: computePressure(input.pressureResult, input.evidenceState),
    confidence: computeConfidence(input.evidenceState),
    complexity: computeComplexity(input.toolCallHistory),
    freshness: computeFreshness(input.pheromones, input.gitChangeRate, input.fsEventRate),
    stability: computeStability(input.doomLevel, input.predictionAcc, input.toolCallHistory, input.evidenceState),
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
// ─── Attention Quality Score (AQS) ───────────────────────────────

/**
 * Metrics for computing attention quality — how much of the context
 * is useful signal vs noise.
 */
export interface AttentionQualityMetrics {
  toolDensity: number
  uniqueToolRatio: number
  avgToolResultSize: number
  userMessageRatio: number
  toolStormLevel?: ToolStormLevel
}

/**
 * Compute Attention Quality Score (0-1).
 *
 * Low AQS (< 0.3) indicates the context is flooded with repetitive
 * tool outputs and the model is likely losing track of user intent.
 * This triggers quality-driven Context Collapse instead of waiting
 * for token-based compaction.
 *
 * Weights:
 * - toolDensity (0.30): high tool density → low quality
 * - uniqueToolRatio (0.25): low diversity → low quality (grep storm)
 * - avgToolResultSize (0.15): large avg results → lower quality
 * - userMessageRatio (0.20): few user messages → agent self-talk
 * - toolStormLevel (0.10): active storm → quality penalty
 */
export function computeAttentionQuality(metrics: AttentionQualityMetrics): number {
  const densityScore = 1 - clamp(metrics.toolDensity)
  const diversityScore = clamp(metrics.uniqueToolRatio)
  const sizeScore = 1 - clamp(metrics.avgToolResultSize / 10_000)
  const userScore = clamp(metrics.userMessageRatio * 3)
  const stormPenalty = metrics.toolStormLevel === 'storm' ? 0
    : metrics.toolStormLevel === 'warn' ? 0.5
    : 1.0

  return clamp(
    0.30 * densityScore +
    0.25 * diversityScore +
    0.15 * sizeScore +
    0.20 * userScore +
    0.10 * stormPenalty,
  )
}

/**
 * Extract AQS metrics from a message window.
 */
export function extractAttentionMetrics(
  messages: Array<{ role: string; content?: string }>,
  recentWindow = 20,
): AttentionQualityMetrics {
  const recent = messages.slice(-recentWindow)
  if (recent.length === 0) {
    return { toolDensity: 0, uniqueToolRatio: 1, avgToolResultSize: 0, userMessageRatio: 1 }
  }

  const toolMessages = recent.filter(m => m.role === 'tool')
  const userMessages = recent.filter(m => m.role === 'user')
  const toolDensity = toolMessages.length / recent.length
  const userMessageRatio = userMessages.length / recent.length

  const toolNames = new Set<string>()
  let totalToolSize = 0
  for (const m of toolMessages) {
    totalToolSize += (m.content ?? '').length
  }
  const avgToolResultSize = toolMessages.length > 0 ? totalToolSize / toolMessages.length : 0
  const uniqueToolRatio = toolMessages.length > 0 ? Math.min(1, toolNames.size / toolMessages.length) : 1

  return { toolDensity, uniqueToolRatio, avgToolResultSize, userMessageRatio }
}

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
