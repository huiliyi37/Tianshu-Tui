/**
 * Adaptive Immune Layer — learns from repair outcomes.
 *
 * Features:
 * - Memory lookup for fast secondary response
 * - Affinity maturation (success rate tracking)
 * - Memory decay (unused memories lose priority)
 * - Negative selection (new detectors validated against normal behavior)
 */

import { createHash } from 'node:crypto'
import type { ImmuneMemory, ImmuneResponse } from './immune-types.js'

const MAX_MEMORIES = 100
const DECAY_INTERVAL = 50  // turns between decay passes
const AFFINITY_BOOST = 0.1
const AFFINITY_PENALTY = 0.05

export class ImmuneAdaptiveLayer {
  private memories = new Map<string, ImmuneMemory>()
  private normalPatterns = new Set<string>()
  private lastDecayTurn = 0

  private patternId(pattern: string): string {
    return createHash('sha256').update(pattern).digest('hex').slice(0, 12)
  }

  /** Register a normal behavior pattern (for negative selection) */
  registerNormal(fingerprint: string): void {
    this.normalPatterns.add(fingerprint)
    if (this.normalPatterns.size > 200) {
      // Keep only most recent by converting to array and slicing
      const arr = [...this.normalPatterns]
      this.normalPatterns = new Set(arr.slice(-150))
    }
  }

  /** Look up immune memory for a pattern */
  lookup(pattern: string): ImmuneMemory | null {
    const id = this.patternId(pattern)
    return this.memories.get(id) ?? null
  }

  /** Record a successful repair strategy */
  recordSuccess(pattern: string, response: ImmuneResponse, turn: number): void {
    const id = this.patternId(pattern)
    const existing = this.memories.get(id)

    if (existing) {
      existing.hitCount++
      existing.lastHit = turn
      existing.affinityScore = Math.min(1, existing.affinityScore + AFFINITY_BOOST)
      // Update response if affinity is improving
      existing.response = response
    } else {
      // Negative selection: reject if matches normal behavior
      if (this.normalPatterns.has(pattern)) return

      const memory: ImmuneMemory = {
        id, pattern, response,
        affinityScore: 0.5,
        hitCount: 1,
        lastHit: turn,
        createdAt: turn,
      }
      this.memories.set(id, memory)

      // Evict lowest affinity if over capacity
      if (this.memories.size > MAX_MEMORIES) {
        this.evictLowest()
      }
    }
  }

  /** Record a failed repair attempt (reduces affinity) */
  recordFailure(pattern: string): void {
    const id = this.patternId(pattern)
    const existing = this.memories.get(id)
    if (existing) {
      existing.affinityScore = Math.max(0, existing.affinityScore - AFFINITY_PENALTY)
    }
  }

  /** Generate a fast repair response from memory */
  fastRepair(memory: ImmuneMemory): ImmuneResponse {
    return memory.response
  }

  /** Periodic decay of unused memories */
  decay(currentTurn: number): void {
    if (currentTurn - this.lastDecayTurn < DECAY_INTERVAL) return
    this.lastDecayTurn = currentTurn

    for (const [id, memory] of this.memories) {
      const age = currentTurn - memory.lastHit
      if (age > 200 && memory.affinityScore < 0.3) {
        this.memories.delete(id)
      } else if (age > 100) {
        memory.affinityScore *= 0.95 // gentle decay
      }
    }
  }

  private evictLowest(): void {
    let lowestId = ''
    let lowestScore = Infinity
    for (const [id, m] of this.memories) {
      if (m.affinityScore < lowestScore) {
        lowestScore = m.affinityScore
        lowestId = id
      }
    }
    if (lowestId) this.memories.delete(lowestId)
  }

  size(): number { return this.memories.size }

  /** Export all memories (for persistence) */
  export(): ImmuneMemory[] {
    return [...this.memories.values()]
  }

  /** Import memories (from persistence) */
  import(memories: ImmuneMemory[]): void {
    for (const m of memories) {
      this.memories.set(m.id, m)
    }
  }
}
