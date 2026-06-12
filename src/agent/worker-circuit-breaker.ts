/**
 * Per-profile circuit breaker for worker delegation.
 *
 * States:
 *   closed    — normal operation; failures increment counter
 *   open      — tripped after threshold consecutive failures; fast-fails all requests
 *   half-open — after cooldown expires; allows one probe request through
 *
 * Transitions:
 *   closed  → open       when failureCount >= threshold
 *   open    → half-open  when Date.now() >= openUntilTs
 *   half-open → closed   on probe success
 *   half-open → open     on probe failure (resets cooldown)
 */

import { profileRegistry } from './profile-registry.js'

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerEntry {
  profileName: string
  state: CircuitState
  failureCount: number
  successCount: number
  lastFailureTs: number
  openUntilTs: number
}

export interface CircuitBreakerConfig {
  failureThreshold?: number
  /** Cooldown for cheap-tier (Flash) profiles in ms */
  cheapCooldownMs?: number
  /** Cooldown for balanced/strong-tier profiles in ms */
  defaultCooldownMs?: number
}

const DEFAULT_CONFIG: Required<CircuitBreakerConfig> = {
  failureThreshold: 3,
  cheapCooldownMs: 30_000,
  defaultCooldownMs: 120_000,
}

export class CircuitBreakerManager {
  private circuits = new Map<string, CircuitBreakerEntry>()
  private config: Required<CircuitBreakerConfig>

  constructor(config?: CircuitBreakerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  private getOrCreate(profileName: string): CircuitBreakerEntry {
    let entry = this.circuits.get(profileName)
    if (!entry) {
      entry = {
        profileName,
        state: 'closed',
        failureCount: 0,
        successCount: 0,
        lastFailureTs: 0,
        openUntilTs: 0,
      }
      this.circuits.set(profileName, entry)
    }
    return entry
  }

  private getCooldownMs(profileName: string): number {
    const profile = profileRegistry.get(profileName)
    return profile?.tierLock === 'cheap'
      ? this.config.cheapCooldownMs
      : this.config.defaultCooldownMs
  }

  /**
   * Check if a delegation request should proceed.
   * Returns 'allow' for closed/half-open-probe, 'deny' for open.
   */
  canDelegate(profileName: string): { allowed: boolean; reason?: string } {
    const entry = this.getOrCreate(profileName)
    const now = Date.now()

    if (entry.state === 'closed') {
      return { allowed: true }
    }

    if (entry.state === 'open') {
      if (now >= entry.openUntilTs) {
        entry.state = 'half-open'
        entry.successCount = 0
        return { allowed: true, reason: 'half-open probe' }
      }
      const remainingMs = entry.openUntilTs - now
      return {
        allowed: false,
        reason: `circuit open for ${profileName} — ${Math.ceil(remainingMs / 1000)}s remaining`,
      }
    }

    // half-open: allow one probe
    return { allowed: true, reason: 'half-open probe' }
  }

  /** Record a successful worker completion. */
  recordSuccess(profileName: string): void {
    const entry = this.getOrCreate(profileName)

    if (entry.state === 'half-open') {
      entry.state = 'closed'
      entry.failureCount = 0
      entry.successCount = 0
      return
    }

    if (entry.state === 'closed') {
      entry.failureCount = 0
      entry.successCount++
    }
  }

  /** Record a worker failure. */
  recordFailure(profileName: string): void {
    const entry = this.getOrCreate(profileName)
    const now = Date.now()

    if (entry.state === 'half-open') {
      entry.state = 'open'
      entry.openUntilTs = now + this.getCooldownMs(profileName)
      entry.lastFailureTs = now
      return
    }

    entry.failureCount++
    entry.lastFailureTs = now

    if (entry.failureCount >= this.config.failureThreshold) {
      entry.state = 'open'
      entry.openUntilTs = now + this.getCooldownMs(profileName)
    }
  }

  /** Get current state for a profile (for observability). */
  getState(profileName: string): CircuitBreakerEntry {
    return { ...this.getOrCreate(profileName) }
  }

  /** Get all circuit states (for TUI panel). */
  getAllStates(): CircuitBreakerEntry[] {
    return [...this.circuits.values()].map(e => ({ ...e }))
  }

  /** Check if any circuit is open (for summary display). */
  hasOpenCircuits(): boolean {
    const now = Date.now()
    for (const entry of this.circuits.values()) {
      if (entry.state === 'open' && now < entry.openUntilTs) return true
    }
    return false
  }

  /** Reset a specific profile's circuit (manual override). */
  reset(profileName: string): void {
    this.circuits.delete(profileName)
  }

  /** Reset all circuits. */
  resetAll(): void {
    this.circuits.clear()
  }
}
