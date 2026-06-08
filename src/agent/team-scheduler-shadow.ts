import type { TeamSchedulerArm, TeamSchedulerRewardInput } from './team-scheduler-bandit.js'
import { computeTeamSchedulerReward, parallelismForTeamSchedulerArm } from './team-scheduler-bandit.js'
import { hashTeamObjective } from './team-wave-telemetry.js'

export interface TeamSchedulerShadowEvent {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  waveId: string
  ruleParallelism: number
  recommendedArm: TeamSchedulerArm
  applied: boolean
  gateOpen: boolean
  reason: string
  pendingRewardId: string
  timestamp: number
}

export interface TeamSchedulerRewardEvent {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  waveId: string
  arm: TeamSchedulerArm
  reward: number
  components: Record<string, number | boolean | string>
  timestamp: number
}

export interface TeamSchedulerStore {
  saveBanditState(kind: string, json: string): void
}

export interface BuildTeamSchedulerShadowInput {
  sessionId: string
  objective: string
  waveId: string
  ruleParallelism: number
  recommendedArm: TeamSchedulerArm
  applied: boolean
  gateOpen: boolean
  reason: string
  timestamp?: number
}

export function teamSchedulerShadowKind(event: Pick<TeamSchedulerShadowEvent, 'sessionId' | 'waveId' | 'timestamp'>): string {
  return `team_scheduler_shadow:${event.sessionId}:${event.waveId}:${event.timestamp}`
}

export function teamSchedulerRewardKind(event: Pick<TeamSchedulerRewardEvent, 'sessionId' | 'waveId' | 'timestamp'>): string {
  return `team_scheduler_reward:${event.sessionId}:${event.waveId}:${event.timestamp}`
}

export function buildTeamSchedulerShadowEvent(input: BuildTeamSchedulerShadowInput): TeamSchedulerShadowEvent {
  const timestamp = input.timestamp ?? Date.now()
  const objectiveHash = hashTeamObjective(input.objective)
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    objectiveHash,
    waveId: input.waveId,
    ruleParallelism: Math.max(1, Math.min(5, Math.trunc(input.ruleParallelism))),
    recommendedArm: input.recommendedArm,
    applied: input.applied,
    gateOpen: input.gateOpen,
    reason: input.reason,
    pendingRewardId: `team_scheduler_reward:${objectiveHash}:${input.sessionId}:${input.waveId}:${timestamp}`,
    timestamp,
  }
}

export function buildTeamSchedulerRewardEvent(input: {
  sessionId: string
  objective: string
  waveId: string
  arm: TeamSchedulerArm
  rewardInput: TeamSchedulerRewardInput
  timestamp?: number
}): TeamSchedulerRewardEvent {
  const reward = computeTeamSchedulerReward(input.rewardInput)
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    objectiveHash: hashTeamObjective(input.objective),
    waveId: input.waveId,
    arm: input.arm,
    reward,
    components: {
      teamWaveReward: input.rewardInput.teamWaveReward,
      conflictRate: input.rewardInput.conflictRate,
      scopeLeakRate: input.rewardInput.scopeLeakRate,
      falseGreen: input.rewardInput.falseGreen,
      parallelism: parallelismForTeamSchedulerArm(input.arm),
    },
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function persistTeamSchedulerShadow(store: TeamSchedulerStore | undefined | null, event: TeamSchedulerShadowEvent): void {
  if (!store) return
  try {
    store.saveBanditState(teamSchedulerShadowKind(event), JSON.stringify(event))
  } catch {
    // Scheduler shadow telemetry must never affect dispatch.
  }
}

export function persistTeamSchedulerReward(store: TeamSchedulerStore | undefined | null, event: TeamSchedulerRewardEvent): void {
  if (!store) return
  try {
    store.saveBanditState(teamSchedulerRewardKind(event), JSON.stringify(event))
  } catch {
    // Scheduler reward telemetry must never affect dispatch.
  }
}
