import type { WorkerProfile } from './work-order.js'

const MAX_HISTORY = 100

interface WorkerOutcome {
  passed: boolean
  latencyMs: number
}

export interface ProfileModelScore {
  totalRuns: number
  passRate: number
  avgLatencyMs: number
}

export class AdaptiveRouter {
  private history = new Map<string, WorkerOutcome[]>()

  private key(profile: WorkerProfile, model: string): string {
    return `${profile}:${model}`
  }

  record(profile: WorkerProfile, model: string, outcome: WorkerOutcome): void {
    const k = this.key(profile, model)
    const entries = this.history.get(k) ?? []
    entries.push(outcome)
    if (entries.length > MAX_HISTORY) {
      this.history.set(k, entries.slice(-MAX_HISTORY))
    } else {
      this.history.set(k, entries)
    }
  }

  getScore(profile: WorkerProfile, model: string): ProfileModelScore | null {
    const entries = this.history.get(this.key(profile, model))
    if (!entries || entries.length === 0) return null
    const passed = entries.filter(e => e.passed).length
    return {
      totalRuns: entries.length,
      passRate: passed / entries.length,
      avgLatencyMs: entries.reduce((sum, e) => sum + e.latencyMs, 0) / entries.length,
    }
  }

  suggestModel(profile: WorkerProfile, candidates: string[]): string | null {
    let best: string | null = null
    let bestScore = -1
    for (const model of candidates) {
      const score = this.getScore(profile, model)
      if (!score) continue
      const composite = score.passRate - (score.avgLatencyMs / 10000)
      if (composite > bestScore) {
        bestScore = composite
        best = model
      }
    }
    return best
  }

  clear(): void {
    this.history.clear()
  }
}
