/**
 * P3 T2-02: Reward function + consistency tracking for LinUCB effort bandit.
 *
 * Composite reward signal from task outcomes (Range [-1, 1]).
 * Also tracks the agreement rate between bandit recommendations and rule baseline
 * for the consistency-promotion gate (A1).
 */

export interface RewardInput {
  /** 0-1, fraction of tools that succeeded without error */
  toolSuccessRate: number
  /** 0-1, fraction of turns that triggered repair */
  repairRate: number
  /** true if doom loop was detected at any point */
  doomDetected: boolean
  /** 1 - actualTokens/expectedTokens, clamped to [-1, 1] */
  tokenEfficiency: number
  /** true if user explicitly interrupted/corrected the agent */
  userCorrected: boolean
}

export interface EffortShadowRecord {
  /** 6-dim context vector built at recommendation time */
  context: number[]
  /** Bandit arm: 'delta:-1' | 'delta:0' | 'delta:+1' */
  recommendedArm: string
  /** The effort the rule-based heuristic selected (e.g., 'medium') */
  ruleBaseline: string
  /** Unique ID for later reward association */
  pendingRewardId: string
  /** Unix ms timestamp of recommendation */
  timestamp: number
}

/**
 * Agreement window entry: records the bandit recommendation and rule baseline.
 * "Agreement" means the effort level the bandit's arm would produce is the same
 * as or adjacent to (±1 in EFFORT_ORDER) the rule baseline.
 */
export interface AgreementEntry {
  /** The effort the rule-based heuristic selected (e.g., 'medium') */
  ruleBaseline: string
  /** Bandit arm: 'delta:-1' | 'delta:0' | 'delta:+1' */
  recommendedArm: string
}

/** Default gate thresholds (瑶光's conservative starting point, not contract) */
export const MIN_PULLS_FOR_GATE = 30
export const AGREEMENT_WINDOW = 20
export const AGREEMENT_RATE_THRESHOLD = 0.8

export const EFFORT_ORDER_GATE = ['off', 'low', 'medium', 'high', 'max'] as const

/**
 * Resolve the effort level a bandit arm would produce from a given baseline.
 * Returns the baseline unchanged if the arm is unknown or out of bounds.
 */
export function resolveArmToEffort(ruleBaseline: string, armId: string): string {
  const idx = EFFORT_ORDER_GATE.indexOf(ruleBaseline as typeof EFFORT_ORDER_GATE[number])
  if (idx === -1) return ruleBaseline
  let delta = 0
  if (armId === 'delta:+1') delta = 1
  else if (armId === 'delta:-1') delta = -1
  const newIdx = Math.max(0, Math.min(EFFORT_ORDER_GATE.length - 1, idx + delta))
  return EFFORT_ORDER_GATE[newIdx]!
}

/**
 * Compute composite reward from task outcome signals.
 *
 * Weights:
 *   toolSuccessRate:  0.4  — primary signal; successful tools = good effort choice
 *   repairRate:       0.3  — inverse; high repair = wrong effort (too low)
 *   doomDetected:     0.2  — penalty; doom = severe mismatch
 *   tokenEfficiency:  0.1  — fine signal; over-token usage
 *   userCorrected:   -0.5  — penalty; explicit correction = bad recommendation
 *
 * Range: [-1, 1]
 */
export function computeEffortReward(input: RewardInput): number {
  const { toolSuccessRate, repairRate, doomDetected, tokenEfficiency, userCorrected } = input

  const doomPenalty = doomDetected ? 1 : 0
  const correctionPenalty = userCorrected ? 1 : 0

  const reward =
    0.4 * clamp(toolSuccessRate, 0, 1) +
    0.3 * (1 - clamp(repairRate, 0, 1)) +
    0.2 * (1 - doomPenalty) +
    0.1 * clamp(tokenEfficiency, -1, 1) -
    0.5 * correctionPenalty

  return clamp(reward, -1, 1)
}

/**
 * Build a 6-dim context vector for the effort bandit.
 *
 * Dimensions:
 *   [0] taskComplexity  0-1
 *   [1] errorRate       0-1
 *   [2] turnDepth       0-1
 *   [3] fileCount       0-1  (log-scaled)
 *   [4] isRepeat        0|1
 *   [5] timeOfDay       0-1
 */
export function buildEffortContext(params: {
  taskComplexity: number
  errorRate: number
  turnDepth: number
  fileCount: number
  isRepeat: boolean
  timeOfDay: number
}): number[] {
  return [
    clamp(params.taskComplexity, 0, 1),
    clamp(params.errorRate, 0, 1),
    clamp(params.turnDepth, 0, 1),
    clamp(Math.log2(Math.max(params.fileCount, 1) + 1) / 5, 0, 1),
    params.isRepeat ? 1 : 0,
    clamp(params.timeOfDay, 0, 1),
  ]
}

// ─── Consistency Gate (Track A1) ──────────────────────────────────────

/**
 * Check whether the bandit is eligible to influence real decisions.
 *
 * Conditions (all must pass):
 * 1. totalPulls >= MIN_PULLS_FOR_GATE (30)
 * 2. In the last AGREEMENT_WINDOW (20) shadow records,
 *    the fraction where the bandit-recommended effort level is the same
 *    as or adjacent to (±1 in EFFORT_ORDER) the rule baseline
 *    is >= AGREEMENT_RATE_THRESHOLD (0.8).
 *
 * "Adjacent" means the bandit nudging ±1 from the rule's selected effort
 * — the bandit is learning in a conservative neighborhood, not thrashing.
 * This prevents the self-defeating paradox where the gate only opens when
 * the bandit recommends delta:0 most of the time (瑶光 ① fix).
 */
export function isBanditGateOpen(
  totalPulls: number,
  agreementWindow: AgreementEntry[],
): boolean {
  if (totalPulls < MIN_PULLS_FOR_GATE) return false
  const window = agreementWindow.slice(-AGREEMENT_WINDOW)
  if (window.length < AGREEMENT_WINDOW) return false

  let agreementCount = 0
  for (const entry of window) {
    const banditEffort = resolveArmToEffort(entry.ruleBaseline, entry.recommendedArm)
    const ruleIdx = EFFORT_ORDER_GATE.indexOf(entry.ruleBaseline as typeof EFFORT_ORDER_GATE[number])
    const banditIdx = EFFORT_ORDER_GATE.indexOf(banditEffort as typeof EFFORT_ORDER_GATE[number])
    // Same or adjacent (within ±1)
    if (ruleIdx !== -1 && banditIdx !== -1 && Math.abs(ruleIdx - banditIdx) <= 1) {
      agreementCount++
    }
  }
  return agreementCount / window.length >= AGREEMENT_RATE_THRESHOLD
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
