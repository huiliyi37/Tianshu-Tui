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
}

/** Minimum ratio delta between consecutive checks to flag fast growth. */
const FAST_GROWTH_THRESHOLD = 0.15

export class PressureMonitor {
  private compactionTurns: number[] = []
  private tokenHistory: Array<{ turn: number; tokens: number }> = []

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

    return {
      tier,
      shouldCompact: tier > 0,
      thrashing,
      fastGrowth,
      suggestion: thrashing ? 'task_decomposition' : undefined,
      ratio,
      growthRate,
    }
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
