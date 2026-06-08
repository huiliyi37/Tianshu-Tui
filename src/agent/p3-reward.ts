/**
 * P3 T2-02: Reward function for LinUCB effort bandit.
 *
 * Composite reward signal from task outcomes. Range [-1, 1].
 * Defined before P0 shadow data collection so every (context, arm) pair
 * has a pendingRewardId slot that can be backfilled with a concrete value.
 *
 * Weights calibrated so different result signals produce distinct reward values
 * (瑶光 gate: "同一 context+arm、不同结果信号 → 不同 reward 值").
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
 *   +1.0 = perfect (100% success, 0% repair, no doom, -50% token usage, no correction)
 *   -1.0 = worst (0% success, 100% repair, doom, 0% token efficiency, user corrected)
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
 *   [0] taskComplexity  0-1  (heuristic from input text length + patterns)
 *   [1] errorRate       0-1  (recent tool error rate)
 *   [2] turnDepth       0-1  (current turn / max turns)
 *   [3] fileCount       0-1  (files modified so far, log-scaled)
 *   [4] isRepeat        0|1  (1 if this looks like a repeated task)
 *   [5] timeOfDay       0-1  (hour/24, proxy for session phase)
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
