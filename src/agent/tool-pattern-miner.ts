export interface ToolPrediction {
  tool: string
  probability: number
  likelyTarget?: string
  source?: 'tool-pattern' | 'physarum-file' | 'combined'
}

export interface ToolPatternEntry {
  tool: string
  targetPath?: string
}

export interface ToolPatternMinerSnapshot {
  version: 1
  bigrams: Array<{ fromTool: string; entries: ToolPatternEntry[] }>
  trigrams: Array<{ context: string; entries: ToolPatternEntry[] }>
  prev: string | null
}

function cloneEntry(entry: ToolPatternEntry): ToolPatternEntry {
  return entry.targetPath === undefined
    ? { tool: entry.tool }
    : { tool: entry.tool, targetPath: entry.targetPath }
}

function normalizeEntries(entries: ToolPatternEntry[], limit: number): ToolPatternEntry[] {
  return entries
    .filter(entry => typeof entry.tool === 'string' && entry.tool.length > 0)
    .slice(-limit)
    .map(cloneEntry)
}

export class ToolPatternMiner {
  private bigrams = new Map<string, ToolPatternEntry[]>()
  private trigrams = new Map<string, ToolPatternEntry[]>()
  private prev: string | null = null

  record(fromTool: string, toTool: string, meta?: { targetPath?: string }): void {
    const entry: ToolPatternEntry = meta?.targetPath === undefined
      ? { tool: toTool }
      : { tool: toTool, targetPath: meta.targetPath }
    // Bigram: A → B
    const biEntries = this.bigrams.get(fromTool) ?? []
    biEntries.push(entry)
    this.bigrams.set(fromTool, biEntries.slice(-200))
    // Trigram: (prev, A) → B
    if (this.prev) {
      const triKey = `${this.prev}|${fromTool}`
      const triEntries = this.trigrams.get(triKey) ?? []
      triEntries.push(entry)
      this.trigrams.set(triKey, triEntries.slice(-100))
    }
    this.prev = fromTool
  }

  predict(fromTool: string, threshold = 0.3): ToolPrediction[] {
    // Try trigram first (higher confidence), only if enough data and different context
    if (this.prev && this.prev !== fromTool) {
      const triKey = `${this.prev}|${fromTool}`
      const triEntries = this.trigrams.get(triKey)
      if (triEntries && triEntries.length >= 3) {
        const triPreds = this.predictFrom(triEntries, threshold)
        if (triPreds.length > 0) return triPreds
      }
    }
    // Fall back to bigram
    return this.predictFrom(this.bigrams.get(fromTool), threshold)
  }

  private predictFrom(entries: ToolPatternEntry[] | undefined, threshold: number): ToolPrediction[] {
    if (!entries || entries.length === 0) return []

    const counts = new Map<string, { count: number; targets: string[] }>()
    for (const e of entries) {
      const existing = counts.get(e.tool) ?? { count: 0, targets: [] }
      existing.count++
      if (e.targetPath) existing.targets.push(e.targetPath)
      counts.set(e.tool, existing)
    }

    const total = entries.length
    const predictions: ToolPrediction[] = []
    for (const [tool, { count, targets }] of counts) {
      const probability = count / total
      if (probability < threshold) continue
      const targetCounts = new Map<string, number>()
      for (const t of targets) targetCounts.set(t, (targetCounts.get(t) ?? 0) + 1)
      let likelyTarget: string | undefined
      let maxCount = 0
      for (const [t, c] of targetCounts) {
        if (c > maxCount) { maxCount = c; likelyTarget = t }
      }
      predictions.push({ tool, probability, likelyTarget })
    }
    return predictions.sort((a, b) => b.probability - a.probability)
  }

  exportSnapshot(): ToolPatternMinerSnapshot {
    return {
      version: 1,
      bigrams: [...this.bigrams.entries()].map(([fromTool, entries]) => ({
        fromTool,
        entries: normalizeEntries(entries, 200),
      })),
      trigrams: [...this.trigrams.entries()].map(([context, entries]) => ({
        context,
        entries: normalizeEntries(entries, 100),
      })),
      prev: this.prev,
    }
  }

  importSnapshot(snapshot: ToolPatternMinerSnapshot): void {
    if (snapshot.version !== 1) return

    this.bigrams = new Map()
    this.trigrams = new Map()

    for (const item of snapshot.bigrams) {
      if (!item.fromTool) continue
      const entries = normalizeEntries(item.entries, 200)
      if (entries.length > 0) this.bigrams.set(item.fromTool, entries)
    }

    for (const item of snapshot.trigrams) {
      if (!item.context) continue
      const entries = normalizeEntries(item.entries, 100)
      if (entries.length > 0) this.trigrams.set(item.context, entries)
    }

    this.prev = typeof snapshot.prev === 'string' && snapshot.prev.length > 0 ? snapshot.prev : null
  }
}
