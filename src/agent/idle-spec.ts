import type { ToolPrediction } from './tool-pattern-miner.js'

export interface IdleSpecDeps {
  miner: { predict(fromTool: string, threshold?: number): ToolPrediction[] }
  queue: { enqueue(prediction: ToolPrediction): void; checkHit(tool: string, target: string): string | undefined }
}

export interface IdleSpecStats {
  speculations: number
  hits: number
  misses: number
}

export class IdleSpec {
  private _stats: IdleSpecStats = { speculations: 0, hits: 0, misses: 0 }

  constructor(private deps: IdleSpecDeps) {}

  onToolStart(toolName: string): void {
    const predictions = this.deps.miner.predict(toolName, 0.3)
    for (const p of predictions) {
      this.deps.queue.enqueue(p)
      this._stats.speculations++
    }
  }

  checkCache(toolName: string, target: string): string | undefined {
    const hit = this.deps.queue.checkHit(toolName, target)
    if (hit !== undefined) this._stats.hits++
    else this._stats.misses++
    return hit
  }

  recordOutcome(hit: boolean): void {
    if (hit) this._stats.hits++
    else this._stats.misses++
  }

  stats(): IdleSpecStats {
    return { ...this._stats }
  }
}
