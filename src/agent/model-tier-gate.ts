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

export function evaluateModelTierGate(input: ModelTierGateInput): ModelTierGateDecision {
  const ruleTier = input.ruleRecommendation.tier
  const candidateTier = tierForModelTierArm(input.candidateArm)
  const candidate = input.state.arms[input.candidateArm]
  const baseline = input.state.arms[modelTierArmForTier(ruleTier)]
  const floor = hardFloorTier(input.ruleRecommendation)

  if (input.state.totalSamples < MIN_TOTAL_TIER_SAMPLES) {
    return { gateOpen: false, applied: false, effectiveTier: ruleTier, reason: `shadow: total samples ${input.state.totalSamples}/${MIN_TOTAL_TIER_SAMPLES}` }
  }
  if (!candidate || candidate.samples < MIN_TIER_ARM_SAMPLES) {
    return { gateOpen: false, applied: false, effectiveTier: ruleTier, reason: `shadow: arm samples ${candidate?.samples ?? 0}/${MIN_TIER_ARM_SAMPLES}` }
  }
  const margin = safeNumber(candidate.averageReward) - safeNumber(baseline?.averageReward ?? 0)
  if (margin < TIER_REWARD_MARGIN) {
    return { gateOpen: false, applied: false, effectiveTier: ruleTier, reason: `shadow: reward margin ${margin.toFixed(3)} < ${TIER_REWARD_MARGIN}` }
  }
  if (safeNumber(input.recentFalseGreenRate) > 0) {
    return { gateOpen: false, applied: false, effectiveTier: ruleTier, reason: 'shadow: false-green observed' }
  }
  if (input.scopeHealthSeverity === 'medium' || input.scopeHealthSeverity === 'high') {
    return { gateOpen: false, applied: false, effectiveTier: ruleTier, reason: `shadow: scope-health veto ${input.scopeHealthSeverity}` }
  }
  if (floor && tierBelow(candidateTier, floor)) {
    return { gateOpen: false, applied: false, effectiveTier: ruleTier, reason: `shadow: hardFloor ${floor} blocks ${candidateTier}` }
  }

  const gateOpen = true
  if (!input.featureFlagEnabled) {
    return { gateOpen, applied: false, effectiveTier: ruleTier, reason: 'shadow: feature flag disabled' }
  }
  return {
    gateOpen,
    applied: true,
    effectiveTier: candidateTier,
    reason: floor ? `applied: ${input.candidateArm} within hardFloor ${floor}` : `applied: ${input.candidateArm}`,
  }
}
