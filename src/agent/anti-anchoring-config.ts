export interface AntiAnchoringConfig {
  /** Master switch. Disabled by default because anti-anchoring changes prompt flow. */
  enabled: boolean
  /** Inject a seedFree exploration directive on selected turns. */
  blindExploration: boolean
  /** Run lightweight multi-path seed planning before the main model commits. */
  mctsPlanning: boolean
  /** Number of MCTS seed branches to request. */
  branches: number
  /** Session turn number where MCTS planning should run. */
  planningTurn: number
  /** Projection threshold used by MCTSPlanner to filter anchor-echo seeds. */
  projectionThreshold: number
  /** Max output tokens for each seed model call. */
  seedMaxTokens: number
}

export const DEFAULT_ANTI_ANCHORING_CONFIG: AntiAnchoringConfig = {
  enabled: true,
  blindExploration: true,
  mctsPlanning: true,
  branches: 3,
  planningTurn: 1,
  projectionThreshold: 0.4,
  seedMaxTokens: 512,
}

export type AntiAnchoringConfigInput = Partial<AntiAnchoringConfig> | boolean | undefined

export function normalizeAntiAnchoringConfig(input: AntiAnchoringConfigInput): AntiAnchoringConfig {
  if (input === true) return { ...DEFAULT_ANTI_ANCHORING_CONFIG, enabled: true }
  if (input === false || input === undefined) return { ...DEFAULT_ANTI_ANCHORING_CONFIG, enabled: false }
  return { ...DEFAULT_ANTI_ANCHORING_CONFIG, ...input }
}
