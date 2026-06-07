import type { PhysarumPredictionObservation } from './physarum-types.js'

export interface PhysarumShadowStats {
  /** Hit-rate semantics: prediction is judged only against the immediately next distinct file access. */
  semantic: 'next-step'
  total: number
  hit1: number
  hit3: number
  miss: number
  hitAt1: number
  hitAt3: number
}

export interface PhysarumPredictionObservationDb {
  getPhysarumPredictionObservations?: (limit?: number) => PhysarumPredictionObservation[]
}

export function emptyPhysarumShadowStats(): PhysarumShadowStats {
  return {
    semantic: 'next-step',
    total: 0,
    hit1: 0,
    hit3: 0,
    miss: 0,
    hitAt1: 0,
    hitAt3: 0,
  }
}

export function aggregatePhysarumPredictionObservations(
  observations: PhysarumPredictionObservation[],
): PhysarumShadowStats {
  const total = observations.length
  if (total === 0) return emptyPhysarumShadowStats()

  let hit1 = 0
  let hit3 = 0
  let miss = 0
  for (const observation of observations) {
    const rank = observation.hitRank
    if (rank === null) {
      miss++
      continue
    }
    if (rank === 1) hit1++
    if (rank >= 1 && rank <= 3) hit3++
  }

  return {
    semantic: 'next-step',
    total,
    hit1,
    hit3,
    miss,
    hitAt1: hit1 / total,
    hitAt3: hit3 / total,
  }
}

export function getPhysarumShadowStatsFromDb(
  db: PhysarumPredictionObservationDb | null | undefined,
  limit = 1000,
): PhysarumShadowStats {
  if (!db?.getPhysarumPredictionObservations) return emptyPhysarumShadowStats()
  try {
    return aggregatePhysarumPredictionObservations(db.getPhysarumPredictionObservations(limit))
  } catch {
    return emptyPhysarumShadowStats()
  }
}
