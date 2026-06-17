/** P2 break-anchor scout — real orthogonal-domain sub-agent dispatched mid-loop. */
export interface AnchorBreakScoutConfig {
  /** Sub-switch (also requires AntiAnchoringConfig.enabled). Default off — workers cost API budget. */
  enabled: boolean
  /** Sensorium complexity peak above which a scout is worthwhile. */
  complexityThreshold: number
  /** Minimum session turn before scouting. */
  minTurn: number
  /** Per-scout timeout budget (ms). */
  scoutBudgetMs: number
  /** Per-scout max output tokens. */
  scoutMaxTokens: number
}

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
  /** P2 break-anchor scout (default off). */
  anchorBreakScout: AnchorBreakScoutConfig
}

export const DEFAULT_ANCHOR_BREAK_SCOUT_CONFIG: AnchorBreakScoutConfig = {
  enabled: false,
  complexityThreshold: 0.5,
  minTurn: 3,
  scoutBudgetMs: 60_000,
  scoutMaxTokens: 2048,
}

export const DEFAULT_ANTI_ANCHORING_CONFIG: AntiAnchoringConfig = {
  enabled: true,
  blindExploration: true,
  mctsPlanning: true,
  branches: 3,
  planningTurn: 1,
  projectionThreshold: 0.4,
  seedMaxTokens: 512,
  anchorBreakScout: { ...DEFAULT_ANCHOR_BREAK_SCOUT_CONFIG },
}

export type AntiAnchoringConfigInput = Partial<AntiAnchoringConfig> | boolean | undefined

export function normalizeAntiAnchoringConfig(input: AntiAnchoringConfigInput): AntiAnchoringConfig {
  if (input === true) {
    return { ...DEFAULT_ANTI_ANCHORING_CONFIG, enabled: true, anchorBreakScout: { ...DEFAULT_ANCHOR_BREAK_SCOUT_CONFIG } }
  }
  if (input === false || input === undefined) {
    return { ...DEFAULT_ANTI_ANCHORING_CONFIG, enabled: false, anchorBreakScout: { ...DEFAULT_ANCHOR_BREAK_SCOUT_CONFIG } }
  }
  return {
    ...DEFAULT_ANTI_ANCHORING_CONFIG,
    ...input,
    anchorBreakScout: { ...DEFAULT_ANCHOR_BREAK_SCOUT_CONFIG, ...(input.anchorBreakScout ?? {}) },
  }
}
