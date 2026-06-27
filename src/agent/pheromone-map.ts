import type { Pheromone, PheromoneQueryResult } from '../context/stigmergy.js'

/**
 * Map persisted stigmergy query results into the in-memory Pheromone shape
 * consumed by perception/runtime hooks. Lifted out of loop.ts (W-L8a) so the
 * runtime-hooks pipeline factory can share it without a loop ↔ loop-factory
 * runtime cycle.
 */
export function mapQueriedPheromones(results: PheromoneQueryResult[]): Pheromone[] {
  return results.map(r => ({
    path: r.path,
    signal: r.signal,
    strength: r.currentStrength,
    depositedAt: r.depositedAt,
    halfLife: r.halfLife,
    ...(r.context ? { context: r.context } : {}),
    ...(r.taskId ? { taskId: r.taskId } : {}),
  }))
}
