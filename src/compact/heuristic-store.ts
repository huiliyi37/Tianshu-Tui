/**
 * Heuristic rule store — JSONL-based persistent storage for cross-session learning.
 *
 * Rules are generated during compaction (Phase 1) and injected at session start (Phase 2).
 * Lifecycle: Hot → Warm → Cold → Archived (based on recency and hit count).
 */
import { createHash } from 'node:crypto'
import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface HeuristicRule {
  id: string
  pattern: string
  antiPattern?: string
  category: string
  confidence: number
  source: 'compaction' | 'session-review' | 'user-correction'
  hitCount: number
  createdAt: number
  lastUsedAt?: number
  sessionId?: string
}

function ruleId(pattern: string): string {
  return createHash('sha256').update(pattern).digest('hex').slice(0, 12)
}

export class HeuristicStore {
  private rules: HeuristicRule[] = []
  private dirty = false

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const data = await readFile(this.path, 'utf-8')
      this.rules = data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch {
      this.rules = []
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    await mkdir(dirname(this.path), { recursive: true })
    const data = this.rules.map(r => JSON.stringify(r)).join('\n') + '\n'
    await writeFile(this.path, data, 'utf-8')
    this.dirty = false
  }

  async append(rules: Omit<HeuristicRule, 'id' | 'hitCount' | 'createdAt'>[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const newRules: HeuristicRule[] = []
    for (const r of rules) {
      const id = ruleId(r.pattern)
      // Dedup: skip if same pattern already exists
      if (this.rules.some(existing => existing.id === id)) continue
      const rule: HeuristicRule = { ...r, id, hitCount: 0, createdAt: Date.now() }
      this.rules.push(rule)
      newRules.push(rule)
    }
    if (newRules.length > 0) {
      const lines = newRules.map(r => JSON.stringify(r)).join('\n') + '\n'
      await appendFile(this.path, lines, 'utf-8')
    }
  }

  /** Get top-K rules for injection, sorted by relevance score. */
  getTopK(k: number, category?: string): HeuristicRule[] {
    const now = Date.now()
    const candidates = category
      ? this.rules.filter(r => r.category === category && r.confidence > 0.2)
      : this.rules.filter(r => r.confidence > 0.2)

    return candidates
      .map(r => ({
        rule: r,
        score: r.confidence * (r.hitCount + 1) * recencyWeight(now, r.lastUsedAt ?? r.createdAt),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(x => x.rule)
  }

  /** Record that a rule was used in a session. */
  recordHit(ruleId: string): void {
    const rule = this.rules.find(r => r.id === ruleId)
    if (rule) {
      rule.hitCount++
      rule.lastUsedAt = Date.now()
      this.dirty = true
    }
  }

  /** Update confidence after session outcome. */
  updateConfidence(ruleId: string, success: boolean): void {
    const rule = this.rules.find(r => r.id === ruleId)
    if (rule) {
      rule.confidence = Math.max(0, Math.min(1, rule.confidence + (success ? 0.1 : -0.2)))
      this.dirty = true
    }
  }

  /** Prune cold rules (>30 days, no hits). Keep max 500 rules. */
  prune(): number {
    const now = Date.now()
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    const before = this.rules.length
    this.rules = this.rules.filter(r =>
      r.confidence > 0.2 || (now - r.createdAt) < thirtyDays || r.hitCount > 0,
    )
    // Cap at 500
    if (this.rules.length > 500) {
      this.rules.sort((a, b) => {
        const sa = a.confidence * (a.hitCount + 1)
        const sb = b.confidence * (b.hitCount + 1)
        return sb - sa
      })
      this.rules = this.rules.slice(0, 500)
    }
    const pruned = before - this.rules.length
    if (pruned > 0) this.dirty = true
    return pruned
  }

  get size(): number { return this.rules.length }
}

function recencyWeight(now: number, lastUsed: number): number {
  const daysSince = (now - lastUsed) / (24 * 60 * 60 * 1000)
  if (daysSince < 7) return 1.0
  if (daysSince < 30) return 0.5
  return 0.2
}
