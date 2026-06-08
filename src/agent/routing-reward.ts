export interface RoutingRewardInput {
  currentModel: string
  recommendedModel?: string
  verificationPass?: boolean
  reviewPass?: boolean
  falseGreen?: boolean
  normalizedCostOverBudget?: number
  normalizedLatencySurprisal?: number
}

export interface RoutingRewardRecord {
  schemaVersion: 1
  reward: number
  components: Record<string, number | boolean | string>
}

const REVIEW_PASS_WEIGHT = 0.30
const VERIFICATION_PASS_WEIGHT = 0.30
const COST_OVER_BUDGET_WEIGHT = 0.10
const LATENCY_SURPRISAL_WEIGHT = 0.10
const FALSE_GREEN_WEIGHT = 0.60

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(max, Math.max(min, value))
}

function scoreOptionalBoolean(value: boolean | undefined): number {
  return value === true ? 1 : 0
}

function scorePenaltyFlag(value: boolean | undefined): number {
  return value === true ? 1 : 0
}

export function normalizeUnitPenalty(value: number | undefined): number {
  return clamp(value ?? 0, 0, 1)
}

/**
 * Compute a shadow-only routing reward.
 *
 * Missing review / verification evidence is neutral (0), never treated as a
 * pass. False-green remains heavier than the maximum cost+latency penalty:
 * 0.60 > 0.10 + 0.10.
 */
export function computeRoutingReward(input: RoutingRewardInput): number {
  const reviewPass = scoreOptionalBoolean(input.reviewPass)
  const verificationPass = scoreOptionalBoolean(input.verificationPass)
  const normalizedCostOverBudget = normalizeUnitPenalty(input.normalizedCostOverBudget)
  const normalizedLatencySurprisal = normalizeUnitPenalty(input.normalizedLatencySurprisal)
  const falseGreen = scorePenaltyFlag(input.falseGreen)

  const reward =
    REVIEW_PASS_WEIGHT * reviewPass +
    VERIFICATION_PASS_WEIGHT * verificationPass -
    COST_OVER_BUDGET_WEIGHT * normalizedCostOverBudget -
    LATENCY_SURPRISAL_WEIGHT * normalizedLatencySurprisal -
    FALSE_GREEN_WEIGHT * falseGreen

  return clamp(reward, -1, 1)
}

export function buildRoutingRewardRecord(input: RoutingRewardInput): RoutingRewardRecord {
  const normalizedCostOverBudget = normalizeUnitPenalty(input.normalizedCostOverBudget)
  const normalizedLatencySurprisal = normalizeUnitPenalty(input.normalizedLatencySurprisal)
  const components: Record<string, number | boolean | string> = {
    currentModel: input.currentModel,
    hasRecommendedModel: input.recommendedModel !== undefined,
    modelMatched: input.recommendedModel !== undefined && input.currentModel === input.recommendedModel,
    reviewObserved: input.reviewPass !== undefined,
    reviewPass: scoreOptionalBoolean(input.reviewPass),
    verificationObserved: input.verificationPass !== undefined,
    verificationPass: scoreOptionalBoolean(input.verificationPass),
    falseGreen: input.falseGreen === true,
    normalizedCostOverBudget,
    normalizedLatencySurprisal,
  }
  if (input.recommendedModel !== undefined) components.recommendedModel = input.recommendedModel

  return {
    schemaVersion: 1,
    reward: computeRoutingReward({
      ...input,
      normalizedCostOverBudget,
      normalizedLatencySurprisal,
    }),
    components,
  }
}
