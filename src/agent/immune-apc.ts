/**
 * APC Aggregator — Antigen-Presenting Cell layer.
 *
 * Collects danger signals and applies dual-signal gating:
 * activation requires BOTH pattern match AND accumulated danger score.
 */

import type { DangerSignal, ActivationDecision, ImmuneResponseType } from './immune-types.js'

const QUARANTINE_THRESHOLD = 1.5
const PRUNE_TOXIC_THRESHOLD = 1.0
const DEPOSIT_WARNING_THRESHOLD = 0.6
const SIGNAL_WINDOW = 10  // turns
const MAX_SIGNALS = 50

export class ApcAggregator {
  private signals: DangerSignal[] = []

  collect(signal: DangerSignal): void {
    this.signals.push(signal)
    if (this.signals.length > MAX_SIGNALS) this.signals.shift()
  }

  /** Dual-signal gating: pattern match (doom detected) AND danger signals */
  evaluate(patternMatch: boolean, currentTurn: number, mistakeCount: number = 0): ActivationDecision {
    // Only consider recent signals
    const recent = this.signals.filter(s => currentTurn - s.turn <= SIGNAL_WINDOW)
    const dangerScore = recent.reduce((sum, s) => sum + s.severity, 0)

    // Softened: effectiveMatch = patternMatch OR (mistakes exist + dangerScore >= 0.8)
    const effectiveMatch = patternMatch || (mistakeCount > 0 && dangerScore >= 0.8)

    if (!effectiveMatch) {
      return { shouldActivate: false, confidence: 0, signals: [] }
    }

    // Three-tier response based on dangerScore
    let shouldActivate: boolean
    let confidence: number
    let responseType: ImmuneResponseType | undefined

    if (dangerScore >= QUARANTINE_THRESHOLD) {
      shouldActivate = true
      confidence = Math.min(dangerScore / 2, 1)
      responseType = 'quarantine'
    } else if (dangerScore >= PRUNE_TOXIC_THRESHOLD) {
      shouldActivate = true
      confidence = Math.min(dangerScore / 2, 1)
      responseType = 'prune_toxic'
    } else if (dangerScore >= DEPOSIT_WARNING_THRESHOLD) {
      shouldActivate = true
      confidence = Math.min(dangerScore / 2, 0.5)
      responseType = 'deposit_warning'
    } else {
      shouldActivate = false
      confidence = 0
    }

    return {
      shouldActivate,
      confidence,
      signals: recent,
      responseType,
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
