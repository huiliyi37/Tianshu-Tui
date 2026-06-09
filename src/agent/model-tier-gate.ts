import type { ModelTier, ModelTierRecommendation } from './model-tier-policy.js'
import type { ModelTierArm, ModelTierBanditState } from './model-tier-bandit.js'
import { modelTierArmForTier, tierForModelTierArm } from './model-tier-bandit.js'
import type { TeamScopeHealthSeverity } from './team-scope-health.js'

export const MIN_TOTAL_TIER_SAMPLES = 30
export const MIN_TIER_ARM_SAMPLES = 5
export const TIER_REWARD_MARGIN = 0.05

export interface ModelTierGateInput {
  state: ModelTierBanditState
  candidateArm: ModelTierArm
  ruleRecommendation: ModelTierRecommendation
  recentFalseGreenRate: number
  scopeHealthSeverity?: TeamScopeHealthSeverity
  featureFlagEnabled?: boolean
}

export interface ModelTierGateDecision {
  gateOpen: boolean
  applied: boolean
  effectiveTier: ModelTier
  reason: string
  evidenceWindow: Record<string, number | boolean | string>
  vetoSignals: string[]
}

const TIER_RANK: Record<ModelTier, number> = {
  cheap: 0,
  balanced: 1,
  strong: 2,
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function tierBelow(left: ModelTier, right: ModelTier): boolean {
  return TIER_RANK[left] < TIER_RANK[right]
}

function hardFloorTier(recommendation: ModelTierRecommendation): ModelTier | undefined {
  return recommendation.hardFloor
}

function makeDecision(
  input: ModelTierGateInput,
  gateOpen: boolean,
  applied: boolean,
  effectiveTier: ModelTier,
  reason: string,
  evidenceWindow: Record<string, number | boolean | string>,
  vetoSignals: string[] = [],
): ModelTierGateDecision {
  return {
    gateOpen,
    applied,
    effectiveTier,
    reason,
    evidenceWindow: {
      source: 'model_tier_bandit',
      totalSamples: input.state.totalSamples,
      minTotalSamples: MIN_TOTAL_TIER_SAMPLES,
      candidateArm: input.candidateArm,
      candidateSamples: input.state.arms[input.candidateArm]?.samples ?? 0,
      minArmSamples: MIN_TIER_ARM_SAMPLES,
      ruleTier: input.ruleRecommendation.tier,
      featureFlagEnabled: input.featureFlagEnabled === true,
      ...evidenceWindow,
    },
    vetoSignals,
  }
}

export function evaluateModelTierGate(input: ModelTierGateInput): ModelTierGateDecision {
  const ruleTier = input.ruleRecommendation.tier
  const candidateTier = tierForModelTierArm(input.candidateArm)
  const candidate = input.state.arms[input.candidateArm]
  const baseline = input.state.arms[modelTierArmForTier(ruleTier)]
  const floor = hardFloorTier(input.ruleRecommendation)

  if (input.state.totalSamples < MIN_TOTAL_TIER_SAMPLES) {
    return makeDecision(input, false, false, ruleTier, `shadow: total samples ${input.state.totalSamples}/${MIN_TOTAL_TIER_SAMPLES}`, {}, ['insufficient_samples'])
  }
  if (!candidate || candidate.samples < MIN_TIER_ARM_SAMPLES) {
    return makeDecision(input, false, false, ruleTier, `shadow: arm samples ${candidate?.samples ?? 0}/${MIN_TIER_ARM_SAMPLES}`, {}, ['insufficient_arm_samples'])
  }
  const margin = safeNumber(candidate.averageReward) - safeNumber(baseline?.averageReward ?? 0)
  if (margin < TIER_REWARD_MARGIN) {
    return makeDecision(input, false, false, ruleTier, `shadow: reward margin ${margin.toFixed(3)} < ${TIER_REWARD_MARGIN}`, { rewardMargin: margin, minRewardMargin: TIER_REWARD_MARGIN }, ['reward_margin'])
  }
  if (safeNumber(input.recentFalseGreenRate) > 0) {
    return makeDecision(input, false, false, ruleTier, 'shadow: false-green observed', { recentFalseGreenRate: safeNumber(input.recentFalseGreenRate) }, ['false_green'])
  }
  if (input.scopeHealthSeverity === 'medium' || input.scopeHealthSeverity === 'high') {
    return makeDecision(input, false, false, ruleTier, `shadow: scope-health veto ${input.scopeHealthSeverity}`, { scopeHealthSeverity: input.scopeHealthSeverity }, ['scope_health'])
  }
  if (floor && tierBelow(candidateTier, floor)) {
    return makeDecision(input, false, false, ruleTier, `shadow: hardFloor ${floor} blocks ${candidateTier}`, { hardFloor: floor, candidateTier }, ['hard_safety_floor'])
  }

  const gateOpen = true
  if (!input.featureFlagEnabled) {
    return makeDecision(input, gateOpen, false, ruleTier, 'shadow: feature flag disabled', { rewardMargin: margin, candidateTier }, ['explicit_flag_closed'])
  }
  return makeDecision(
    input,
    gateOpen,
    true,
    candidateTier,
    floor ? `applied: ${input.candidateArm} within hardFloor ${floor}` : `applied: ${input.candidateArm}`,
    { rewardMargin: margin, candidateTier, ...(floor ? { hardFloor: floor } : {}) },
  )
}
