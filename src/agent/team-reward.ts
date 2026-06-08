import type { TeamWaveTelemetry } from './team-wave-telemetry.js'
import { normalizeUnitPenalty } from './routing-reward.js'
import { buildTeamWaveScopeHealth } from './team-scope-health.js'

export interface TeamWaveRewardInput {
  verificationPass?: boolean
  reviewPass?: boolean
  normalizedConflict: number
  normalizedRework: number
  normalizedScopeLeak: number
  normalizedCostOverBudget: number
  normalizedLatencySurprisal: number
  falseGreen: boolean
}

export interface TeamWaveRewardRecord {
  schemaVersion: 1
  reward: number
  components: Record<string, number | boolean | string>
}

const REVIEW_PASS_WEIGHT = 0.30
const VERIFICATION_PASS_WEIGHT = 0.30
const CONFLICT_WEIGHT = 0.15
const REWORK_WEIGHT = 0.15
const SCOPE_LEAK_WEIGHT = 0.15
const COST_OVER_BUDGET_WEIGHT = 0.10
const LATENCY_SURPRISAL_WEIGHT = 0.10
const FALSE_GREEN_WEIGHT = 0.60

function clampReward(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(-1, value))
}

function scoreOptionalBoolean(value: boolean | undefined): number {
  return value === true ? 1 : 0
}

function normalizeReviewVerdict(verdict: string | undefined): boolean | undefined {
  if (!verdict) return undefined
  const normalized = verdict.trim().toLowerCase().replace(/[\s_-]+/g, '-')
  if (!normalized) return undefined
  if (['pass', 'passed', 'verified', 'approve', 'approved', 'ok', 'clean', 'green', 'no-findings'].includes(normalized)) return true
  if (['fail', 'failed', 'rejected', 'reject', 'blocked', 'changes-requested', 'red'].includes(normalized)) return false
  return undefined
}

function denominator(event: TeamWaveTelemetry): number {
  return Math.max(event.outcome.dispatched, event.outcome.statuses.length, 1)
}

function normalizeScopeLeak(event: TeamWaveTelemetry): number {
  return buildTeamWaveScopeHealth(event).scopeLeakRate
}

function hasFalseGreen(event: TeamWaveTelemetry, reviewPass: boolean | undefined): boolean {
  const statuses = event.outcome.statuses
  const hasPassedWithoutVerifiedEvidence = statuses.some(status =>
    status.status === 'passed' && status.evidenceStatus !== 'verified'
  )
  const allPassed = statuses.length > 0 && statuses.every(status => status.status === 'passed')
  return hasPassedWithoutVerifiedEvidence ||
    (allPassed && event.outcome.verificationPassed === false) ||
    (allPassed && reviewPass === false)
}

export function computeTeamWaveReward(input: TeamWaveRewardInput): number {
  const reviewPass = scoreOptionalBoolean(input.reviewPass)
  const verificationPass = scoreOptionalBoolean(input.verificationPass)
  const normalizedConflict = normalizeUnitPenalty(input.normalizedConflict)
  const normalizedRework = normalizeUnitPenalty(input.normalizedRework)
  const normalizedScopeLeak = normalizeUnitPenalty(input.normalizedScopeLeak)
  const normalizedCostOverBudget = normalizeUnitPenalty(input.normalizedCostOverBudget)
  const normalizedLatencySurprisal = normalizeUnitPenalty(input.normalizedLatencySurprisal)
  const falseGreen = input.falseGreen ? 1 : 0

  const reward =
    REVIEW_PASS_WEIGHT * reviewPass +
    VERIFICATION_PASS_WEIGHT * verificationPass -
    CONFLICT_WEIGHT * normalizedConflict -
    REWORK_WEIGHT * normalizedRework -
    SCOPE_LEAK_WEIGHT * normalizedScopeLeak -
    COST_OVER_BUDGET_WEIGHT * normalizedCostOverBudget -
    LATENCY_SURPRISAL_WEIGHT * normalizedLatencySurprisal -
    FALSE_GREEN_WEIGHT * falseGreen

  return clampReward(reward)
}

export function deriveTeamWaveRewardInput(event: TeamWaveTelemetry): TeamWaveRewardInput {
  const denom = denominator(event)
  const reviewPass = normalizeReviewVerdict(event.outcome.reviewVerdict)
  const blockedOrEscalated = event.outcome.statuses.filter(status =>
    status.status === 'blocked' || status.status === 'escalated'
  ).length
  const failedOrFailedEvidence = event.outcome.statuses.filter(status =>
    status.status === 'failed' || status.evidenceStatus === 'failed'
  ).length

  return {
    verificationPass: event.outcome.verificationPassed,
    reviewPass,
    normalizedConflict: normalizeUnitPenalty(blockedOrEscalated / denom),
    normalizedRework: normalizeUnitPenalty(failedOrFailedEvidence / denom),
    normalizedScopeLeak: normalizeScopeLeak(event),
    // P1 has no cost/latency telemetry in TeamWaveTelemetry yet. Missing facts
    // are neutral rather than guessed.
    normalizedCostOverBudget: 0,
    normalizedLatencySurprisal: 0,
    falseGreen: hasFalseGreen(event, reviewPass),
  }
}

export function buildTeamWaveRewardRecord(input: TeamWaveRewardInput): TeamWaveRewardRecord {
  const normalizedConflict = normalizeUnitPenalty(input.normalizedConflict)
  const normalizedRework = normalizeUnitPenalty(input.normalizedRework)
  const normalizedScopeLeak = normalizeUnitPenalty(input.normalizedScopeLeak)
  const normalizedCostOverBudget = normalizeUnitPenalty(input.normalizedCostOverBudget)
  const normalizedLatencySurprisal = normalizeUnitPenalty(input.normalizedLatencySurprisal)
  return {
    schemaVersion: 1,
    reward: computeTeamWaveReward({
      ...input,
      normalizedConflict,
      normalizedRework,
      normalizedScopeLeak,
      normalizedCostOverBudget,
      normalizedLatencySurprisal,
    }),
    components: {
      reviewObserved: input.reviewPass !== undefined,
      reviewPass: scoreOptionalBoolean(input.reviewPass),
      verificationObserved: input.verificationPass !== undefined,
      verificationPass: scoreOptionalBoolean(input.verificationPass),
      normalizedConflict,
      normalizedRework,
      normalizedScopeLeak,
      normalizedCostOverBudget,
      normalizedLatencySurprisal,
      falseGreen: input.falseGreen,
    },
  }
}
