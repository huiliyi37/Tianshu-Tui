export interface ToolPrediction {
  tool: string
  probability: number
  likelyTarget?: string
}

interface BigramEntry {
  tool: string
  targetPath?: string
}

export class ToolPatternMiner {
  private bigrams = new Map<string, BigramEntry[]>()

  record(fromTool: string, toTool: string, meta?: { targetPath?: string }): void {
    const entries = this.bigrams.get(fromTool) ?? []
    entries.push({ tool: toTool, targetPath: meta?.targetPath })
    this.bigrams.set(fromTool, entries.slice(-200))
  }

  predict(fromTool: string, threshold = 0.3): ToolPrediction[] {
    const entries = this.bigrams.get(fromTool)
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
}
