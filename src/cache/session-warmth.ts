import type { CacheTemperature } from './types.js'

export interface SessionWarmthConfig {
  now?: () => number
  ttlMs?: number
}

export class SessionWarmthTracker {
  private lastApiCallTime: number = 0
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(config: SessionWarmthConfig = {}) {
    this.now = config.now ?? (() => Date.now())
    this.ttlMs = config.ttlMs ?? 3600_000
  }

  predict(): CacheTemperature {
    if (this.lastApiCallTime === 0) return 'cold'
    const elapsed = this.now() - this.lastApiCallTime
    if (elapsed < 60_000) return 'hot'
    if (elapsed < this.ttlMs) return 'warm'
    return 'cold'
  }

  shouldOpportunisticCompact(): boolean {
    return this.predict() === 'cold'
  }

  recordApiCall(): void {
    this.lastApiCallTime = this.now()
  }
}
