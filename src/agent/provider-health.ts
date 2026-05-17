/**
 * Physarum-inspired provider health state machine.
 *
 * Three-tier model (hot → warm → cold) with asymmetric weight updates:
 * success slowly increases weight, failure rapidly decreases it (4x speed).
 * Inspired by slime mold tube dynamics: negative signals propagate faster.
 *
 * Standalone component — consumed by coordinator (worker routing) and
 * agent loop (sensorium stability dimension).
 */

// ─── Types ──────────────────────────────────────────────────────────

export type ProviderTier = 'hot' | 'warm' | 'cold'

export interface ProviderHealth {
  providerId: string
  tier: ProviderTier
  weight: number
  consecutiveSuccesses: number
  consecutiveFailures: number
  lastSuccessAt: number
  lastFailureAt: number
}

interface SerializedProviderHealth {
  providerId: string
  tier: ProviderTier
  weight: number
  consecutiveSuccesses: number
  consecutiveFailures: number
  lastSuccessAt: number
  lastFailureAt: number
}

// ─── Constants ──────────────────────────────────────────────────────

const SUCCESS_GAIN = 0.1 // weight += 0.1 * (1 - weight)
const FAILURE_PENALTY = 0.4 // weight -= 0.4 * weight (4x asymmetry)
const MIN_WEIGHT = 0.05

// Tier transition thresholds
const HOT_TO_WARM_FAILURES = 2
const WARM_TO_COLD_FAILURES = 3
const COLD_TO_WARM_SUCCESSES = 1
const WARM_TO_HOT_SUCCESSES = 3

// ─── ProviderHealthTracker ─────────────────────────────────────────

export class ProviderHealthTracker {
  private providers = new Map<string, ProviderHealth>()

  // ── Registration ────────────────────────────────────────────

  registerProvider(providerId: string): void {
    if (this.providers.has(providerId)) return
    const now = Date.now()
    this.providers.set(providerId, {
      providerId,
      tier: 'hot',
      weight: 1.0,
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      lastSuccessAt: now,
      lastFailureAt: 0,
    })
  }

  // ── Weight updates ───────────────────────────────────────────

  recordSuccess(providerId: string): void {
    const p = this.providers.get(providerId)
    if (!p) return

    const now = Date.now()
    p.weight = Math.min(1, p.weight + SUCCESS_GAIN * (1 - p.weight))
    p.consecutiveSuccesses += 1
    p.consecutiveFailures = 0
    p.lastSuccessAt = now

    this.evaluateTier(p)
  }

  recordFailure(providerId: string): void {
    const p = this.providers.get(providerId)
    if (!p) return

    const now = Date.now()
    p.weight = Math.max(MIN_WEIGHT, p.weight - FAILURE_PENALTY * p.weight)
    p.consecutiveFailures += 1
    p.consecutiveSuccesses = 0
    p.lastFailureAt = now

    this.evaluateTier(p)
  }

  // ── Tier transitions ─────────────────────────────────────────

  private evaluateTier(p: ProviderHealth): void {
    switch (p.tier) {
      case 'hot':
        if (p.consecutiveFailures >= HOT_TO_WARM_FAILURES) {
          p.tier = 'warm'
          p.consecutiveFailures = 0 // reset for warm-tier counting
        }
        break

      case 'warm':
        if (p.consecutiveFailures >= WARM_TO_COLD_FAILURES) {
          p.tier = 'cold'
          p.consecutiveFailures = 0
        } else if (p.consecutiveSuccesses >= WARM_TO_HOT_SUCCESSES) {
          p.tier = 'hot'
          p.consecutiveSuccesses = 0
        }
        break

      case 'cold':
        if (p.consecutiveSuccesses >= COLD_TO_WARM_SUCCESSES) {
          p.tier = 'warm'
          p.consecutiveFailures = 0 // reset so warm→cold doesn't immediately trigger
          p.consecutiveSuccesses = 0
        }
        break
    }
  }

  // ── Provider selection ───────────────────────────────────────

  /**
   * Select a provider using weighted random from the hot tier.
   *
   * Falls back to warm tier if no hot providers exist.
   * Returns undefined if all providers are cold.
   */
  selectProvider(): string | undefined {
    const hot = this.getTierProviders('hot')
    if (hot.length > 0) return this.weightedRandom(hot)

    const warm = this.getTierProviders('warm')
    if (warm.length > 0) return this.weightedRandom(warm)

    return undefined
  }

  private getTierProviders(tier: ProviderTier): ProviderHealth[] {
    return [...this.providers.values()].filter(p => p.tier === tier)
  }

  private weightedRandom(candidates: ProviderHealth[]): string {
    if (candidates.length === 1) return candidates[0]!.providerId

    const totalWeight = candidates.reduce((sum, p) => sum + p.weight, 0)
    if (totalWeight <= 0) return candidates[0]!.providerId

    let r = Math.random() * totalWeight
    for (const p of candidates) {
      r -= p.weight
      if (r <= 0) return p.providerId
    }
    return candidates[candidates.length - 1]!.providerId
  }

  // ── Snapshot ─────────────────────────────────────────────────

  getWeights(): ProviderHealth[] {
    return [...this.providers.values()].map(p => ({ ...p }))
  }

  /**
   * Aggregate health summary for sensorium stability integration.
   * Returns 0 (all hot, full weight) to 1 (all cold, zero weight).
   */
  getDegradationRatio(): number {
    const all = [...this.providers.values()]
    if (all.length === 0) return 0

    const totalWeight = all.reduce((sum, p) => sum + p.weight, 0)
    const maxWeight = all.length // all at 1.0
    return 1 - totalWeight / maxWeight
  }

  // ── Persistence ──────────────────────────────────────────────

  toJSON(): SerializedProviderHealth[] {
    return [...this.providers.values()].map(p => ({
      providerId: p.providerId,
      tier: p.tier,
      weight: p.weight,
      consecutiveSuccesses: p.consecutiveSuccesses,
      consecutiveFailures: p.consecutiveFailures,
      lastSuccessAt: p.lastSuccessAt,
      lastFailureAt: p.lastFailureAt,
    }))
  }

  static fromJSON(data: SerializedProviderHealth[]): ProviderHealthTracker {
    const tracker = new ProviderHealthTracker()
    for (const entry of data) {
      tracker.providers.set(entry.providerId, { ...entry })
    }
    return tracker
  }
}
