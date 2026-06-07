/**
 * Immune System — Types
 *
 * Danger Theory inspired: detect "danger signals" not just "non-self".
 * Dual-signal gating reduces false positives.
 */

export type DangerSignalKind =
  | 'compaction_fail'
  | 'token_spike'
  | 'tool_repeat'
  | 'prediction_error'
  | 'graph_anomaly'
  | 'repair_exhaustion'
  | 'sycophancy_detected'
  | 'tdd_violation'
  | 'immune_hook_error'

export interface DangerSignal {
  kind: DangerSignalKind
  severity: number       // [0, 1]
  turn: number
  source: string
  context?: string
}

export interface ImmuneMemory {
  id: string
  pattern: string
  response: ImmuneResponse
  affinityScore: number
  hitCount: number
  lastHit: number
  createdAt: number
}

export type ImmuneResponseType = 'quarantine' | 'prune_toxic' | 'boost_healthy' | 'deposit_warning'

export interface ImmuneResponse {
  type: ImmuneResponseType
  targetFile?: string
  toxicEdges?: Array<{ fileA: string; fileB: string }>
  healthyEdges?: Array<{ fileA: string; fileB: string }>
  duration?: number
}

export interface ActivationDecision {
  shouldActivate: boolean
  confidence: number
  signals: DangerSignal[]
  responseType?: ImmuneResponseType
}
