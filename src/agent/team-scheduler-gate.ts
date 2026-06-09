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
  evidenceWindow: Record<string, number | boolean | string>
  vetoSignals: string[]
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function makeDecision(
  input: TeamSchedulerGateInput,
  gateOpen: boolean,
  applied: boolean,
  reason: string,
  evidenceWindow: Record<string, number | boolean | string>,
  vetoSignals: string[] = [],
): TeamSchedulerGateDecision {
  return {
    gateOpen,
    applied,
    reason,
    evidenceWindow: {
      source: 'team_scheduler_bandit',
      totalSamples: input.state.totalSamples,
      minTotalSamples: MIN_TOTAL_SAMPLES,
      candidateArm: input.candidateArm,
      candidateSamples: input.state.arms[input.candidateArm]?.samples ?? 0,
      minArmSamples: MIN_ARM_SAMPLES,
      ruleParallelism: Math.max(1, Math.min(5, Math.trunc(input.ruleParallelism))),
      featureFlagEnabled: input.featureFlagEnabled === true,
      ...evidenceWindow,
    },
    vetoSignals,
  }
}

export function evaluateTeamSchedulerGate(input: TeamSchedulerGateInput): TeamSchedulerGateDecision {
  const candidate = input.state.arms[input.candidateArm]
  const candidateParallelism = parallelismForTeamSchedulerArm(input.candidateArm)
  const ruleParallelism = Math.max(1, Math.min(5, Math.trunc(input.ruleParallelism)))

  if (input.state.totalSamples < MIN_TOTAL_SAMPLES) {
    return makeDecision(input, false, false, `shadow: total samples ${input.state.totalSamples}/${MIN_TOTAL_SAMPLES}`, {}, ['insufficient_samples'])
  }
  if (!candidate || candidate.samples < MIN_ARM_SAMPLES) {
    return makeDecision(input, false, false, `shadow: arm samples ${candidate?.samples ?? 0}/${MIN_ARM_SAMPLES}`, {}, ['insufficient_arm_samples'])
  }
  const margin = safeNumber(candidate.averageReward) - safeNumber(input.ruleBaselineReward)
  if (margin < REWARD_MARGIN) {
    return makeDecision(input, false, false, `shadow: reward margin ${margin.toFixed(3)} < ${REWARD_MARGIN}`, { rewardMargin: margin, minRewardMargin: REWARD_MARGIN }, ['reward_margin'])
  }
  if (safeNumber(input.recentFalseGreenRate) > MAX_FALSE_GREEN_RATE) {
    return makeDecision(input, false, false, 'shadow: false-green observed', { recentFalseGreenRate: safeNumber(input.recentFalseGreenRate) }, ['false_green'])
  }
  if (safeNumber(input.ruleAgreementRate) < MIN_RULE_AGREEMENT) {
    return makeDecision(input, false, false, `shadow: rule agreement ${input.ruleAgreementRate.toFixed(2)} < ${MIN_RULE_AGREEMENT}`, { ruleAgreementRate: safeNumber(input.ruleAgreementRate), minRuleAgreement: MIN_RULE_AGREEMENT }, ['rule_agreement'])
  }
  if (!input.hardGateSafe || candidateParallelism > ruleParallelism) {
    return makeDecision(input, false, false, 'shadow: hard gate blocks candidate', { candidateParallelism, hardGateSafe: input.hardGateSafe }, ['hard_safety_floor', ...(candidateParallelism > ruleParallelism ? ['down_only'] : [])])
  }

  const gateOpen = true
  if (!input.featureFlagEnabled) return makeDecision(input, gateOpen, false, 'shadow: feature flag disabled', { rewardMargin: margin, candidateParallelism }, ['explicit_flag_closed'])
  return makeDecision(input, gateOpen, true, `applied: ${input.candidateArm} within rule parallelism ${ruleParallelism}`, { rewardMargin: margin, candidateParallelism })
}

export function applyTeamSchedulerInfluence(ruleParallelism: number, candidateArm: TeamSchedulerArm, gate: TeamSchedulerGateDecision): number {
  const safeRule = Math.max(1, Math.min(5, Math.trunc(ruleParallelism)))
  if (!gate.applied) return safeRule
  return Math.max(1, Math.min(safeRule, parallelismForTeamSchedulerArm(candidateArm), 5))
}
