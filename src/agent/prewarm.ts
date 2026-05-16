import type { PrewarmValue } from './prewarm-file.js'

interface CacheEntry {
  value: PrewarmValue
  timestamp: number
  accessOrder: number
}

export class PrewarmCache {
  private store = new Map<string, CacheEntry>()
  private hits = 0
  private misses = 0
  private accessCounter = 0

  constructor(
    private ttlMs = 30_000,
    private maxEntries = 20,
  ) {}

  set(key: string, value: PrewarmValue): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      let oldestKey: string | null = null
      let oldestOrder = Infinity
      for (const [candidateKey, entry] of this.store) {
        if (entry.accessOrder < oldestOrder) {
          oldestOrder = entry.accessOrder
          oldestKey = candidateKey
        }
      }
      if (oldestKey) this.store.delete(oldestKey)
    }
    this.store.set(key, { value, timestamp: Date.now(), accessOrder: ++this.accessCounter })
  }

  has(key: string): boolean {
    const entry = this.store.get(key)
    if (!entry) return false
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.store.delete(key)
      return false
    }
    return true
  }

  get(key: string): PrewarmValue | undefined {
    const entry = this.store.get(key)
    if (!entry) { this.misses++; return undefined }
    const now = Date.now()
    if (now - entry.timestamp > this.ttlMs) {
      this.store.delete(key)
      this.misses++
      return undefined
    }
    this.hits++
    entry.timestamp = now
    entry.accessOrder = ++this.accessCounter
    return entry.value
  }

  invalidate(key: string): void {
    this.store.delete(key)
  }

  expireAll(): void {
    this.store.clear()
  }

  stats(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses
    return { hits: this.hits, misses: this.misses, hitRate: total > 0 ? this.hits / total : 0 }
  }
}
