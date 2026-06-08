/**
 * P3 T2-02: Reward function + reward-based consistency gate for LinUCB effort bandit.
 *
 * Composite reward signal from task outcomes (Range [-1, 1]).
 * The consistency gate is reward-based: it checks whether the bandit's
 * deviation from "no change" (delta:0) is backed by measured reward.
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

/** Gate thresholds (conservative starting point, adjustable with evidence) */
export const MIN_PULLS_FOR_GATE = 30
export const MIN_ARM_PULLS = 5
export const REWARD_MARGIN = 0.05

export interface ArmStat {
  id: string
  pulls: number
  avgReward: number
}

/**
 * Reward-based consistency gate.
 *
 * All conditions must pass:
 * 1. totalPulls ≥ MIN_PULLS_FOR_GATE (30) — sufficient training data
 * 2. The best deviating arm (delta:+1 or delta:-1) by avgReward has
 *    pulls ≥ MIN_ARM_PULLS (5) — not a single-sample fluke
 * 3. That arm's avgReward ≥ delta:0's avgReward + REWARD_MARGIN (0.05) —
 *    deviation's measured benefit genuinely exceeds "do nothing"
 *
 * accept=+0.75 / reject=-0.25 → avgReward ∈ [-0.25, +0.75]
 */
export function isBanditGateOpen(armStats: ArmStat[]): boolean {
  const totalPulls = armStats.reduce((sum, s) => sum + s.pulls, 0)
  if (totalPulls < MIN_PULLS_FOR_GATE) return false

  const noop = armStats.find(s => s.id === 'delta:0')
  if (!noop || noop.pulls === 0) return false

  // Best deviating arm by avgReward
  const deviating = armStats
    .filter(s => s.id === 'delta:-1' || s.id === 'delta:+1')
    .reduce<ArmStat | null>((best, s) => {
      if (!best) return s
      return s.avgReward > best.avgReward ? s : best
    }, null)

  if (!deviating || deviating.pulls < MIN_ARM_PULLS) return false

  return deviating.avgReward >= noop.avgReward + REWARD_MARGIN
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
