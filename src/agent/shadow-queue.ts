import type { ToolPrediction } from './tool-pattern-miner.js'

const READ_ONLY_SPECULATIVE_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_dir'])

export interface ShadowQueueDeps {
  execute: (tool: string, target: string) => Promise<string>
  minProbability?: number
}

interface CachedResult {
  tool: string
  target: string
  result: string
}

export class ShadowQueue {
  private cache: CachedResult[] = []
  private inflight = 0
  private readonly minProbability: number

  constructor(private deps: ShadowQueueDeps) {
    this.minProbability = deps.minProbability ?? 0.4
  }

  enqueue(prediction: ToolPrediction): void {
    if (prediction.probability < this.minProbability) return
    if (!READ_ONLY_SPECULATIVE_TOOLS.has(prediction.tool)) return
    if (!prediction.likelyTarget) return
    this.inflight++
    const target = prediction.likelyTarget
    void this.deps.execute(prediction.tool, target).then(result => {
      this.cache.push({ tool: prediction.tool, target, result })
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
    return hit.result
  }

  pending(): number { return this.inflight }
  clear(): void { this.cache = [] }
}
