/**
 * Innate Immune Layer — fast, fixed-rule danger signal detection.
 *
 * Detects: tool repetition, token spikes, rate limit violations.
 * No learning — pure pattern matching on recent history.
 */

import type { DangerSignal } from './immune-types.js'

export interface InnateCheckInput {
  toolName: string
  fingerprint: string
  turn: number
  tokenUsage?: number
  /** When true, this call was an error — do not count toward tool_repeat signals. */
  isError?: boolean
}

const WINDOW_SIZE = 20
const REPEAT_THRESHOLD = 3
const TOKEN_SPIKE_MULTIPLIER = 2.5

export class InnateLayer {
  private fingerprints: string[] = []
  private tokenHistory: number[] = []

  check(input: InnateCheckInput): DangerSignal[] {
    const signals: DangerSignal[] = []

    // Track fingerprint — only for successful calls. Error calls (isError=true)
    // are infrastructure failures, not "stuck in a loop" behavior.
    if (!input.isError) {
      this.fingerprints.push(input.fingerprint)
      if (this.fingerprints.length > WINDOW_SIZE) this.fingerprints.shift()

      // Tool repeat detection (successful calls only)
      const count = this.fingerprints.filter(f => f === input.fingerprint).length
      if (count >= REPEAT_THRESHOLD) {
        signals.push({
          kind: 'tool_repeat',
          severity: Math.min(count / 5, 1),
          turn: input.turn,
          source: input.toolName,
          context: `fingerprint repeated ${count}x in last ${WINDOW_SIZE}`,
        })
      }
    }

    // Token spike detection
    if (input.tokenUsage != null) {
      this.tokenHistory.push(input.tokenUsage)
      if (this.tokenHistory.length > 10) this.tokenHistory.shift()

      if (this.tokenHistory.length >= 3) {
        const avg = this.tokenHistory.slice(0, -1).reduce((s, v) => s + v, 0) / (this.tokenHistory.length - 1)
        if (input.tokenUsage > avg * TOKEN_SPIKE_MULTIPLIER) {
          signals.push({
            kind: 'token_spike',
            severity: Math.min((input.tokenUsage / avg - 1) / 3, 1),
            turn: input.turn,
            source: input.toolName,
            context: `${input.tokenUsage} tokens vs avg ${Math.round(avg)}`,
          })
        }
      }
    }

    return signals
  }

  clear(): void {
    this.fingerprints = []
    this.tokenHistory = []
  }
}
