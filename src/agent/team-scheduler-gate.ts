import type { TeamSchedulerArm, TeamSchedulerBanditState } from './team-scheduler-bandit.js'
import { parallelismForTeamSchedulerArm } from './team-scheduler-bandit.js'

export const MIN_TOTAL_SAMPLES = 30
export const MIN_ARM_SAMPLES = 5
export const REWARD_MARGIN = 0.05
export const MAX_FALSE_GREEN_RATE = 0
export const MIN_RULE_AGREEMENT = 0.80

export interface TeamSchedulerGateInput {
  state: TeamSchedulerBanditState
  candidateArm: TeamSchedulerArm
  ruleParallelism: number
  ruleBaselineReward: number
  recentFalseGreenRate: number
  ruleAgreementRate: number
  hardGateSafe: boolean
  featureFlagEnabled?: boolean
}

export interface TeamSchedulerGateDecision {
  gateOpen: boolean
  applied: boolean
  reason: string
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

export function evaluateTeamSchedulerGate(input: TeamSchedulerGateInput): TeamSchedulerGateDecision {
  const candidate = input.state.arms[input.candidateArm]
  const candidateParallelism = parallelismForTeamSchedulerArm(input.candidateArm)
  const ruleParallelism = Math.max(1, Math.min(5, Math.trunc(input.ruleParallelism)))

  if (input.state.totalSamples < MIN_TOTAL_SAMPLES) {
    return { gateOpen: false, applied: false, reason: `shadow: total samples ${input.state.totalSamples}/${MIN_TOTAL_SAMPLES}` }
  }
  if (!candidate || candidate.samples < MIN_ARM_SAMPLES) {
    return { gateOpen: false, applied: false, reason: `shadow: arm samples ${candidate?.samples ?? 0}/${MIN_ARM_SAMPLES}` }
  }
  const margin = safeNumber(candidate.averageReward) - safeNumber(input.ruleBaselineReward)
  if (margin < REWARD_MARGIN) {
    return { gateOpen: false, applied: false, reason: `shadow: reward margin ${margin.toFixed(3)} < ${REWARD_MARGIN}` }
  }
  if (safeNumber(input.recentFalseGreenRate) > MAX_FALSE_GREEN_RATE) {
    return { gateOpen: false, applied: false, reason: 'shadow: false-green observed' }
  }
  if (safeNumber(input.ruleAgreementRate) < MIN_RULE_AGREEMENT) {
    return { gateOpen: false, applied: false, reason: `shadow: rule agreement ${input.ruleAgreementRate.toFixed(2)} < ${MIN_RULE_AGREEMENT}` }
  }
  if (!input.hardGateSafe || candidateParallelism > ruleParallelism) {
    return { gateOpen: false, applied: false, reason: 'shadow: hard gate blocks candidate' }
  }

  const gateOpen = true
  if (!input.featureFlagEnabled) return { gateOpen, applied: false, reason: 'shadow: feature flag disabled' }
  return { gateOpen, applied: true, reason: `applied: ${input.candidateArm} within rule parallelism ${ruleParallelism}` }
}

export function applyTeamSchedulerInfluence(ruleParallelism: number, candidateArm: TeamSchedulerArm, gate: TeamSchedulerGateDecision): number {
  const safeRule = Math.max(1, Math.min(5, Math.trunc(ruleParallelism)))
  if (!gate.applied) return safeRule
  return Math.max(1, Math.min(safeRule, parallelismForTeamSchedulerArm(candidateArm), 5))
}
