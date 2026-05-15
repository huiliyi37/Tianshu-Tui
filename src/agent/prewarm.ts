interface CacheEntry {
  value: string
  timestamp: number
}

export class PrewarmCache {
  private store = new Map<string, CacheEntry>()
  private hits = 0
  private misses = 0

  constructor(
    private ttlMs = 30_000,
    private maxEntries = 20,
  ) {}

  set(key: string, value: string): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value!
      this.store.delete(oldest)
    }
    this.store.set(key, { value, timestamp: Date.now() })
  }

  get(key: string): string | undefined {
    const entry = this.store.get(key)
    if (!entry) { this.misses++; return undefined }
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.store.delete(key)
      this.misses++
      return undefined
    }
    this.hits++
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
