/**
 * APC Aggregator — Antigen-Presenting Cell layer.
 *
 * Collects danger signals and applies dual-signal gating:
 * activation requires BOTH pattern match AND accumulated danger score.
 */

import type { DangerSignal, ActivationDecision } from './immune-types.js'

const ACTIVATION_THRESHOLD = 1.2
const SIGNAL_WINDOW = 10  // turns
const MAX_SIGNALS = 50

export class ApcAggregator {
  private signals: DangerSignal[] = []

  collect(signal: DangerSignal): void {
    this.signals.push(signal)
    if (this.signals.length > MAX_SIGNALS) this.signals.shift()
  }

  /** Dual-signal gating: pattern match (doom detected) AND danger signals */
  evaluate(patternMatch: boolean, currentTurn: number): ActivationDecision {
    if (!patternMatch) {
      return { shouldActivate: false, confidence: 0, signals: [] }
    }

    // Only consider recent signals
    const recent = this.signals.filter(s => currentTurn - s.turn <= SIGNAL_WINDOW)
    const dangerScore = recent.reduce((sum, s) => sum + s.severity, 0)
    const shouldActivate = dangerScore >= ACTIVATION_THRESHOLD

    return {
      shouldActivate,
      confidence: Math.min(dangerScore / 2, 1),
      signals: recent,
    }
  }

  /** Get current danger level without gating (for monitoring) */
  getDangerLevel(currentTurn: number): number {
    const recent = this.signals.filter(s => currentTurn - s.turn <= SIGNAL_WINDOW)
    return recent.reduce((sum, s) => sum + s.severity, 0)
  }

  clear(): void {
    this.signals = []
  }
}
