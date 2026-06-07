/**
 * Physarum Topology Engine — Types
 *
 * Adaptive edge evolution inspired by Physarum polycephalum network optimization.
 * Edges grow with flow (access frequency) and decay without use.
 */

export interface PhysarumEdgeState {
  fileA: string
  fileB: string
  weight: number
  flow: number              // recent access count (sliding window)
  consolidated: boolean     // long-term memory (slow decay)
  activationCount: number
  lastActivatedTurn: number
  direction: number         // STDP directionality [-1, 1], 0 = symmetric
}

export interface PhysarumPredictionObservation {
  sourceFile: string
  predictedAtTurn: number
  predictions: Array<{ file: string; score: number }>
  observedFile: string
  observedAtTurn: number
  hitRank: number | null
  leadTurns: number
}

export interface PhysarumConfig {
  growthRate: number         // flow-driven growth coefficient
  gamma: number             // flow exponent (>1 = winner-take-all)
  tauShort: number          // unconsolidated decay (turns)
  tauLong: number           // consolidated decay (turns)
  consolidationThreshold: number
  pruneThreshold: number
  synapticBudget: number    // max total outgoing weight per node
  ubiquityThreshold: number // connectivity ratio triggering penalty
  stdpWindow: number        // STDP time window (turns)
  stdpPlus: number          // LTP learning rate
  stdpMinus: number         // LTD learning rate
}

export const DEFAULT_PHYSARUM_CONFIG: PhysarumConfig = {
  growthRate: 0.1,
  gamma: 1.2,
  tauShort: 50,       // ~50 turns ≈ short session
  tauLong: 500,       // ~500 turns ≈ many sessions
  consolidationThreshold: 5,
  pruneThreshold: 0.05,
  synapticBudget: 10.0,
  ubiquityThreshold: 0.3,
  stdpWindow: 5,
  stdpPlus: 0.3,
  stdpMinus: 0.1,
}

export type Criticality = 'subcritical' | 'critical' | 'supercritical'

export interface AvalancheStats {
  sizes: number[]
  lastCheckedTurn: number
}

export interface PhysarumStats {
  prunedThisTurn: number
  avgPruneRate: number
  maxNodeGrowth: number
  avgGrowth: number
  criticality: Criticality
}
