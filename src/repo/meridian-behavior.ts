import type { MeridianDb } from './meridian-db.js'
import type { StigmergyStore } from '../context/stigmergy.js'

const CO_EDIT_BLACKLIST = [
  'package.json', 'package-lock.json', 'tsconfig.json',
  '.eslintrc', '.prettierrc', 'yarn.lock', 'pnpm-lock.yaml',
]

function isBlacklisted(filePath: string): boolean {
  return CO_EDIT_BLACKLIST.some(p => filePath.endsWith(p))
}

export interface BehaviorWeights {
  structural: number
  coEdit: number
  accessHeat: number
  pheromone: number
}

const DEFAULT_WEIGHTS: BehaviorWeights = {
  structural: 1.0,
  coEdit: 0.6,
  accessHeat: 0.3,
  pheromone: 0.2,
}

export class MeridianBehavior {
  private editBuffer: Set<string> = new Set()
  private currentTurn = 0
  /** Pre-loaded pheromone cache for sync access during graph queries */
  private pheromoneCache: Map<string, number> = new Map()

  constructor(
    private db: MeridianDb,
    private stigmergy?: StigmergyStore,
    private weights: BehaviorWeights = DEFAULT_WEIGHTS,
  ) {}

  /** Load pheromone signals into cache (call before sync graph queries) */
  async refreshPheromoneCache(): Promise<void> {
    if (!this.stigmergy) return
    const all = await this.stigmergy.query()
    this.pheromoneCache.clear()
    for (const p of all) {
      const existing = this.pheromoneCache.get(p.path) ?? 0
      this.pheromoneCache.set(p.path, existing + p.currentStrength)
    }
  }

  recordEdit(filePath: string, turn: number): void {
    if (isBlacklisted(filePath)) return
    if (turn !== this.currentTurn) {
      this.flushCoEdits()
      this.currentTurn = turn
      this.editBuffer.clear()
    }
    this.editBuffer.add(filePath)
  }

  flushCoEdits(): void {
    const files = [...this.editBuffer]
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        this.db.recordCoEdit(files[i]!, files[j]!, this.currentTurn)
      }
    }
    this.editBuffer.clear()
  }

  getFileBoost(filePath: string): number {
    let boost = 0
    const coNeighbors = this.db.getCoEditNeighbors(filePath)
    const coEditScore = coNeighbors.reduce((sum, n) => sum + n.weight, 0)
    boost += Math.min(coEditScore, 5.0) * this.weights.coEdit

    const heat = this.db.getAccessHeat(filePath)
    boost += Math.min(heat, 3.0) * this.weights.accessHeat

    const pheromoneScore = this.pheromoneCache.get(filePath) ?? 0
    boost += Math.min(pheromoneScore, 2.0) * this.weights.pheromone

    return boost
  }

  getCoEditEdges(seedFile: string): Array<{ targetFile: string; weight: number }> {
    if (isBlacklisted(seedFile)) return []
    return this.db.getCoEditNeighbors(seedFile)
      .filter(n => !isBlacklisted(n.file))
      .map(n => ({ targetFile: n.file, weight: n.weight * this.weights.coEdit }))
  }
}
