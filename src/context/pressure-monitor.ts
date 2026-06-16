import type { CompactTier } from './types.js'
import { tierForRatio } from './compact-policy.js'

export interface PressureResult {
  tier: CompactTier
  shouldCompact: boolean
  thrashing: boolean
  fastGrowth: boolean
  suggestion?: 'task_decomposition'
  ratio: number
  growthRate: number
  /** CVM overhead: fraction of context consumed by CVM injections (0–1) */
  cvmOverheadRatio: number
  /** Should CVM throttle its injections to reduce overhead? */
  shouldThrottleCvm: boolean
}

/** Minimum ratio delta between consecutive checks to flag fast growth. */
const FAST_GROWTH_THRESHOLD = 0.15

/** CVM overhead threshold: throttle when CVM injections exceed 5% of context. */
const CVM_OVERHEAD_THRESHOLD = 0.05
/** CVM overhead ceiling: hard stop at 8% — skip all non-essential injections. */
const CVM_OVERHEAD_CEILING = 0.08

export class PressureMonitor {
  private compactionTurns: number[] = []
  private tokenHistory: Array<{ turn: number; tokens: number }> = []
  /** Accumulated CVM-injected token estimate across this session. */
  private cvmTokenAccumulator = 0

  constructor(private contextWindow: number) {}

  check(estimatedTokens: number, currentTurn: number): PressureResult {
    const ratio = this.contextWindow > 0 ? estimatedTokens / this.contextWindow : 1
    const tier = tierForRatio(ratio)
    const thrashing = this.detectThrashing(currentTurn)

    // ── Growth rate: ratio delta since last check ──
    const prevRatio = this.tokenHistory.length > 0
      ? (this.tokenHistory[this.tokenHistory.length - 1]!.tokens / this.contextWindow)
      : ratio
    const growthRate = ratio - prevRatio
    const fastGrowth = growthRate >= FAST_GROWTH_THRESHOLD

    // Record for next comparison
    this.tokenHistory = [...this.tokenHistory, { turn: currentTurn, tokens: estimatedTokens }].slice(-20)

    // ── CVM overhead ──
    const cvmOverheadRatio = this.contextWindow > 0
      ? this.cvmTokenAccumulator / this.contextWindow
      : 0

    const shouldCompact = tier > 0

    return {
      tier,
      shouldCompact,
      thrashing,
      fastGrowth,
      suggestion: thrashing && shouldCompact ? 'task_decomposition' : undefined,
      ratio,
      growthRate,
      cvmOverheadRatio,
      shouldThrottleCvm: cvmOverheadRatio >= CVM_OVERHEAD_THRESHOLD,
    }
  }

  /**
   * Record CVM-injected tokens for overhead tracking.
   * Call this each turn with the estimated token count of CVM injections
   * (cognitive mirror, uncertainty hints, sycophancy traps, etc.).
   *
   * Overhead accumulates across the session. If it exceeds thresholds,
   * the next check() will signal shouldThrottleCvm.
   */
  recordCvmInjection(estimatedTokens: number): void {
    this.cvmTokenAccumulator += estimatedTokens
  }

  /** Reset CVM overhead counter (e.g., after checkpoint-resume). */
  resetCvmOverhead(): void {
    this.cvmTokenAccumulator = 0
  }

  getCvmOverheadRatio(): number {
    return this.contextWindow > 0
      ? this.cvmTokenAccumulator / this.contextWindow
      : 0
  }

  isCvmThrottlingCeiling(): boolean {
    return this.getCvmOverheadRatio() >= CVM_OVERHEAD_CEILING
  }

  recordCompaction(turn: number): void {
    this.compactionTurns = [...this.compactionTurns, turn].slice(-10)
  }

  getCompactionTurns(): number[] {
    return [...this.compactionTurns]
  }

  private detectThrashing(currentTurn: number): boolean {
    return this.compactionTurns.filter(turn => currentTurn - turn <= 4).length >= 3
  }
}
