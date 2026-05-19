import { createHash } from 'crypto'

export interface HabituationConfig {
  threshold: number
}

interface FieldState {
  hash: string
  content: string
  stableCount: number
  habituated: boolean
}

function sha256short(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export class FieldHabituationTracker {
  private fields = new Map<string, FieldState>()
  private readonly threshold: number

  constructor(config: HabituationConfig) {
    this.threshold = config.threshold
  }

  recordTurn(fieldValues: Record<string, string>): void {
    const seen = new Set<string>()

    for (const [name, content] of Object.entries(fieldValues)) {
      seen.add(name)
      const hash = sha256short(content)
      const existing = this.fields.get(name)

      if (!existing) {
        this.fields.set(name, { hash, content, stableCount: 1, habituated: false })
        continue
      }

      if (existing.hash === hash) {
        existing.stableCount++
        if (existing.stableCount >= this.threshold && !existing.habituated) {
          existing.habituated = true
        }
      } else {
        existing.hash = hash
        existing.content = content
        existing.stableCount = 0
        existing.habituated = false
      }
    }

    for (const [name, state] of this.fields) {
      if (!seen.has(name)) {
        state.hash = sha256short('')
        state.content = ''
        state.stableCount = 0
        state.habituated = false
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
