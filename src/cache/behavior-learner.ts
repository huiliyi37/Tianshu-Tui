import type { DiscoveredCacheBehavior } from './types.js'

export interface CacheObservation {
  cacheRead: number
  cacheCreation: number
  prefixChanged: boolean
}

export class CacheBehaviorLearner {
  private observations: CacheObservation[] = []

  observe(obs: CacheObservation): void {
    this.observations.push(obs)
    if (this.observations.length > 50) this.observations.shift()
  }

  infer(): DiscoveredCacheBehavior {
    const n = this.observations.length
    if (n < 3) {
      return { hasCache: false, matchingStrategy: 'unknown', observedMinTokens: null, confidence: 0 }
    }

    const hasAnyCache = this.observations.some(o => o.cacheRead > 0)
    if (!hasAnyCache) {
      const hasCreation = this.observations.some(o => o.cacheCreation > 0)
      if (!hasCreation) {
        return { hasCache: false, matchingStrategy: 'unknown', observedMinTokens: null, confidence: Math.min(n / 10, 0.95) }
      }
      return { hasCache: false, matchingStrategy: 'unknown', observedMinTokens: null, confidence: Math.min(n / 10, 0.9) }
    }

    // Detect exact-prefix: prefix changes always cause cache miss
    const afterChange = this.observations.filter(o => o.prefixChanged)
    const exactPrefix = afterChange.length >= 1 && afterChange.every(o => o.cacheRead === 0)

    return {
      hasCache: true,
      matchingStrategy: exactPrefix ? 'exact-prefix' : (afterChange.length === 0 ? 'unknown' : 'partial'),
      observedMinTokens: null,
      confidence: Math.min(n / 8, 0.95),
    }
  }

  reset(): void {
    this.observations = []
  }
}
