import { createHash } from 'crypto'

export interface HabituationConfig {
  /** Confidence threshold for promotion (0.0-1.0). Default: 0.8 */
  promotionThreshold?: number
  /** Decay multiplier when field is absent. Default: 0.3 */
  decayRate?: number
  /** @deprecated Use promotionThreshold + decayRate for new confidence mode */
  threshold?: number
}

interface FieldState {
  hash: string
  content: string
  /** Legacy fixed counter — only used in threshold mode */
  stableCount: number
  /** Confidence accumulator — only used in confidence mode */
  confidence: number
  habituated: boolean
}

/** Phase -> accumulation rate (IRF4-inspired positive feedback) */
const ALPHA_TABLE: Record<string, number> = {
  explore: 0.10,   // ~15 turns to habituate
  plan:    0.20,   // ~7 turns
  execute: 0.35,   // ~4 turns
  verify:  0.30,   // ~5 turns
  deliver: 0.40,   // ~3 turns
}
const DEFAULT_ALPHA = 0.20

function sha256short(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function getAlpha(phaseHint?: string): number {
  if (phaseHint) {
    const rate = ALPHA_TABLE[phaseHint]
    if (rate !== undefined) return rate
  }
  return DEFAULT_ALPHA
}

export class FieldHabituationTracker {
  private fields = new Map<string, FieldState>()
  private readonly promotionThreshold: number
  private readonly decayRate: number
  private readonly legacyThreshold: number | null

  constructor(config: HabituationConfig) {
    if (config.threshold !== undefined && config.promotionThreshold === undefined) {
      // Backward compat: fixed counter mode
      this.legacyThreshold = config.threshold
      this.promotionThreshold = 0.8
      this.decayRate = 0.3
    } else {
      // New confidence mode
      this.legacyThreshold = null
      this.promotionThreshold = config.promotionThreshold ?? 0.8
      this.decayRate = config.decayRate ?? 0.3
    }
  }

  recordTurn(fieldValues: Record<string, string>, phaseHint?: string): void {
    const alpha = getAlpha(phaseHint)
    const useLegacy = this.legacyThreshold !== null
    const seen = new Set<string>()

    for (const [name, content] of Object.entries(fieldValues)) {
      seen.add(name)
      const hash = sha256short(content)
      const existing = this.fields.get(name)

      if (!existing) {
        const state: FieldState = {
          hash,
          content,
          stableCount: useLegacy ? 1 : 0,
          confidence: useLegacy ? 0 : alpha,
          habituated: false,
        }
        if (useLegacy && this.legacyThreshold! <= 1) {
          state.habituated = true
        }
        this.fields.set(name, state)
        continue
      }

      if (existing.hash === hash) {
        if (useLegacy) {
          // Legacy fixed counter mode
          existing.stableCount++
          if (existing.stableCount >= this.legacyThreshold! && !existing.habituated) {
            existing.habituated = true
          }
        } else {
          // Confidence mode: positive feedback (B-cell IRF4)
          existing.confidence += (1 - existing.confidence) * alpha
          if (existing.confidence >= this.promotionThreshold && !existing.habituated) {
            existing.habituated = true
          }
        }
      } else {
        // Change: reset
        existing.hash = hash
        existing.content = content
        if (useLegacy) {
          existing.stableCount = 1
        } else {
          existing.confidence = alpha
        }
        existing.habituated = false
      }
    }

    // Absent fields
    for (const [name, state] of this.fields) {
      if (!seen.has(name)) {
        if (useLegacy) {
          // Legacy: hard reset
          state.hash = sha256short('')
          state.content = ''
          state.stableCount = 0
          state.habituated = false
        } else {
          // Confidence mode: gradual decay (Physarum-inspired)
          state.confidence *= (1 - this.decayRate)
          if (state.habituated && state.confidence < this.promotionThreshold) {
            state.habituated = false
          }
        }
      }
    }
  }

  getHabituated(): Set<string> {
    const result = new Set<string>()
    for (const [name, state] of this.fields) {
      if (state.habituated) result.add(name)
    }
    return result
  }

  getActive(): Set<string> {
    const result = new Set<string>()
    for (const [name, state] of this.fields) {
      if (!state.habituated) result.add(name)
    }
    return result
  }

  getHabituatedContent(): Map<string, string> {
    const result = new Map<string, string>()
    for (const [name, state] of this.fields) {
      if (state.habituated) result.set(name, state.content)
    }
    return result
  }
}
