import type { GhostEntry } from './types.js'

export interface GhostRegistryConfig {
  maxEntries?: number
}

type GhostRecord = Omit<GhostEntry, 'accessedAfterEviction'> & { accessedAfterEviction: number }

export class GhostRegistry {
  private entries = new Map<string, GhostRecord>()
  private readonly maxEntries: number

  constructor(config: GhostRegistryConfig = {}) {
    this.maxEntries = config.maxEntries ?? 200
  }

  record(entry: Omit<GhostEntry, 'accessedAfterEviction'>): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value!
      this.entries.delete(oldest)
    }
    this.entries.set(entry.artifactId, { ...entry, accessedAfterEviction: 0 })
  }

  markAccessed(artifactId: string, _currentTurn: number): void {
    const entry = this.entries.get(artifactId)
    if (entry) entry.accessedAfterEviction++
  }

  /** Ghost entries evicted within `withinTurns` of `currentTurn` AND accessed after eviction */
  getRecentGhostHits(withinTurns: number, currentTurn: number): GhostEntry[] {
    const result: GhostEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.accessedAfterEviction > 0 && currentTurn - entry.evictedAtTurn <= withinTurns) {
        result.push(entry)
      }
    }
    return result
  }

  /** Fraction of evicted entries NEVER re-accessed (higher = better eviction policy) */
  getEvictionEfficiency(): number {
    if (this.entries.size === 0) return 1
    let neverAccessed = 0
    for (const entry of this.entries.values()) {
      if (entry.accessedAfterEviction === 0) neverAccessed++
    }
    return neverAccessed / this.entries.size
  }

  size(): number {
    return this.entries.size
  }
}
