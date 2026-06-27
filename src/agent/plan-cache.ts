/**
 * P3-E: Plan-to-Plan Cache
 *
 * Records successful tool sequences as reusable plan templates.
 * On new tasks, matches by keyword overlap and replays cached plans.
 * Invalidation: file change events expire entries touching that path.
 *
 * Based on: APC (Stanford, ICML 2025), muscle-mem pattern.
 */

export interface PlanStep {
  tool: string
  target: string
  /** Abstract: strip absolute paths to relative */
  args?: Record<string, unknown>
}

export interface PlanTemplate {
  id: string
  keywords: string[]
  steps: PlanStep[]
  createdAt: number
  hitCount: number
  lastHitAt: number
}

export interface PlanCacheConfig {
  maxEntries?: number
  minSteps?: number
  maxAgeMs?: number
}

const DEFAULT_MAX = 64
const DEFAULT_MIN_STEPS = 2
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export class PlanCache {
  private entries = new Map<string, PlanTemplate>()
  private readonly maxEntries: number
  private readonly minSteps: number
  private readonly maxAgeMs: number

  constructor(config: PlanCacheConfig = {}) {
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX
    this.minSteps = config.minSteps ?? DEFAULT_MIN_STEPS
    this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  }

  /** Record a successful tool sequence as a plan template */
  record(taskDescription: string, steps: PlanStep[]): PlanTemplate | null {
    if (steps.length < this.minSteps) return null
    const keywords = extractKeywords(taskDescription)
    if (keywords.length === 0) return null

    const id = keywords.sort().join(':').slice(0, 64)
    const existing = this.entries.get(id)
    if (existing) {
      existing.steps = steps
      existing.hitCount++
      existing.lastHitAt = Date.now()
      return existing
    }

    const template: PlanTemplate = {
      id,
      keywords,
      steps,
      createdAt: Date.now(),
      hitCount: 0,
      lastHitAt: Date.now(),
    }
    this.entries.set(id, template)
    this.evict()
    return template
  }

  /** Find a matching plan for a new task */
  lookup(taskDescription: string): PlanTemplate | null {
    const keywords = extractKeywords(taskDescription)
    if (keywords.length === 0) return null

    const now = Date.now()
    let best: PlanTemplate | null = null
    let bestScore = 0

    for (const entry of this.entries.values()) {
      if (now - entry.createdAt > this.maxAgeMs) continue
      const overlap = keywords.filter(k => entry.keywords.includes(k)).length
      const score = overlap / Math.max(keywords.length, entry.keywords.length)
      if (score > bestScore && score >= 0.5) {
        bestScore = score
        best = entry
      }
    }

    if (best) {
      best.hitCount++
      best.lastHitAt = Date.now()
    }
    return best
  }

  /** Expose entries for serialization (read-only reference). */
  getEntries(): ReadonlyMap<string, PlanTemplate> {
    return this.entries
  }

  /** Invalidate entries that reference a changed file path */
  invalidate(filePath: string): number {
    let removed = 0
    for (const [id, entry] of this.entries) {
      if (entry.steps.some(s => s.target.includes(filePath) || filePath.includes(s.target))) {
        this.entries.delete(id)
        removed++
      }
    }
    return removed
  }

  size(): number { return this.entries.size }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return
    // Remove oldest, least-hit entries
    const sorted = [...this.entries.entries()]
      .sort((a, b) => a[1].lastHitAt - b[1].lastHitAt)
    while (this.entries.size > this.maxEntries && sorted.length > 0) {
      this.entries.delete(sorted.shift()![0])
    }
  }
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-./]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && w.length < 40)
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .slice(0, 12)
}
