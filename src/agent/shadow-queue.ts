import type { ToolPrediction } from './tool-pattern-miner.js'

const READ_ONLY_SPECULATIVE_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_dir'])

export interface ShadowQueueDeps {
  execute: (tool: string, target: string) => Promise<string>
  minProbability?: number
}

type PredictionSource = NonNullable<ToolPrediction['source']>

interface CachedResult {
  tool: string
  target: string
  result: string
  source: PredictionSource
}

export type ShadowQueueSourceStats = Record<PredictionSource, { enqueued: number; hits: number }>

function emptySourceStats(): ShadowQueueSourceStats {
  return {
    'tool-pattern': { enqueued: 0, hits: 0 },
    'physarum-file': { enqueued: 0, hits: 0 },
    combined: { enqueued: 0, hits: 0 },
    llm: { enqueued: 0, hits: 0 },
  }
}

export class ShadowQueue {
  private cache: CachedResult[] = []
  private inflight = 0
  private readonly minProbability: number
  private sourceStats: ShadowQueueSourceStats = emptySourceStats()

  constructor(private deps: ShadowQueueDeps) {
    this.minProbability = deps.minProbability ?? 0.4
  }

  enqueue(prediction: ToolPrediction): void {
    if (prediction.probability < this.minProbability) return
    if (!READ_ONLY_SPECULATIVE_TOOLS.has(prediction.tool)) return
    if (!prediction.likelyTarget) return
    this.inflight++
    const target = prediction.likelyTarget
    const source: PredictionSource = prediction.source ?? 'tool-pattern'
    this.sourceStats[source].enqueued++
    void this.deps.execute(prediction.tool, target).then(result => {
      this.cache.push({ tool: prediction.tool, target, result, source })
    }).catch(() => {
      // Speculative execution failed — silently absorb.
      // Shadow queue is best-effort; failures should not cause
      // unhandledRejection or disrupt the main agent loop.
    }).finally(() => { this.inflight-- })
  }

  checkHit(tool: string, target: string): string | undefined {
    const idx = this.cache.findIndex(c => c.tool === tool && c.target === target)
    if (idx === -1) return undefined
    const [hit] = this.cache.splice(idx, 1) as [CachedResult]
    this.sourceStats[hit.source].hits++
    return hit.result
  }

  /** Per-source enqueue/hit counters — which prediction source is earning its keep. */
  statsBySource(): ShadowQueueSourceStats {
    return {
      'tool-pattern': { ...this.sourceStats['tool-pattern'] },
      'physarum-file': { ...this.sourceStats['physarum-file'] },
      combined: { ...this.sourceStats.combined },
      llm: { ...this.sourceStats.llm },
    }
  }

  pending(): number { return this.inflight }
  clear(): void { this.cache = [] }
}
