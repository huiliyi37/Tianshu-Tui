import { LinUCBBandit } from './linucb-bandit.js'

export type TeamSchedulerArm =
  | 'parallelism:1'
  | 'parallelism:2'
  | 'parallelism:3'
  | 'parallelism:4'
  | 'parallelism:5'

export interface TeamSchedulerContext {
  taskCount: number
  writeTaskCount: number
  readTaskCount: number
  dependencyDepth: number
  crossModuleScore: number
  highRiskRatio: number
  historicalReward: number
  scopeLeakRate: number
}

export interface TeamSchedulerRewardInput {
  teamWaveReward: number
  conflictRate: number
  scopeLeakRate: number
  falseGreen: boolean
}

export interface TeamSchedulerBanditState {
  totalSamples: number
  arms: Record<TeamSchedulerArm, { samples: number; totalReward: number; averageReward: number }>
}

export interface TeamSchedulerRecommendation {
  arm: TeamSchedulerArm
  score: number
  confidence: number
}

export interface TeamSchedulerRewardSummaryStore {
  loadBanditStatesByPrefix?(prefix: string, limit?: number): Array<{ kind: string; json: string }>
}

const CONTEXT_DIMENSION = 8
const SCHEDULER_ARMS: TeamSchedulerArm[] = [
  'parallelism:1',
  'parallelism:2',
  'parallelism:3',
  'parallelism:4',
  'parallelism:5',
]

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function clampReward(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(-1, value))
}

export function allTeamSchedulerArms(): TeamSchedulerArm[] {
  return [...SCHEDULER_ARMS]
}

export function teamSchedulerArmForParallelism(parallelism: number): TeamSchedulerArm {
  const safe = Math.max(1, Math.min(5, Math.trunc(parallelism)))
  return `parallelism:${safe}` as TeamSchedulerArm
}

export function parallelismForTeamSchedulerArm(arm: TeamSchedulerArm): number {
  return Number.parseInt(arm.split(':')[1] ?? '1', 10)
}

export function normalizeTeamSchedulerContext(context: TeamSchedulerContext): number[] {
  return [
    clampUnit(context.taskCount),
    clampUnit(context.writeTaskCount),
    clampUnit(context.readTaskCount),
    clampUnit(context.dependencyDepth),
    clampUnit(context.crossModuleScore),
    clampUnit(context.highRiskRatio),
    clampReward(context.historicalReward),
    clampUnit(context.scopeLeakRate),
  ]
}

export function computeTeamSchedulerReward(input: TeamSchedulerRewardInput): number {
  return clampReward(
    clampReward(input.teamWaveReward) -
      0.30 * clampUnit(input.conflictRate) -
      0.30 * clampUnit(input.scopeLeakRate) -
      0.60 * (input.falseGreen ? 1 : 0),
  )
}

export function createTeamSchedulerBandit(): LinUCBBandit {
  const bandit = new LinUCBBandit({ dimension: CONTEXT_DIMENSION, alpha: 1.2, minConfidence: 0.05 })
  for (const arm of SCHEDULER_ARMS) bandit.addArm(arm)
  return bandit
}

export function recommendTeamSchedulerArm(
  bandit: LinUCBBandit,
  context: TeamSchedulerContext,
): TeamSchedulerRecommendation {
  const rec = bandit.recommend(normalizeTeamSchedulerContext(context))
  if (!rec) return { arm: 'parallelism:1', score: 0, confidence: 0 }
  const arm = SCHEDULER_ARMS.includes(rec.armId as TeamSchedulerArm)
    ? rec.armId as TeamSchedulerArm
    : 'parallelism:1'
  return { arm, score: rec.score, confidence: rec.confidence }
}

export function updateTeamSchedulerBandit(
  bandit: LinUCBBandit,
  arm: TeamSchedulerArm,
  context: TeamSchedulerContext,
  reward: number,
): void {
  bandit.update(arm, normalizeTeamSchedulerContext(context), clampReward(reward))
}

function emptyTeamSchedulerState(): TeamSchedulerBanditState {
  return {
    totalSamples: 0,
    arms: Object.fromEntries(SCHEDULER_ARMS.map(arm => [arm, { samples: 0, totalReward: 0, averageReward: 0 }])) as TeamSchedulerBanditState['arms'],
  }
}

export function summarizeTeamSchedulerBandit(bandit: LinUCBBandit): TeamSchedulerBanditState {
  const stats = bandit.getStats()
  const state = emptyTeamSchedulerState()
  for (const stat of stats) {
    if (!SCHEDULER_ARMS.includes(stat.id as TeamSchedulerArm)) continue
    const arm = stat.id as TeamSchedulerArm
    const totalReward = stat.avgReward * stat.pulls
    state.arms[arm] = { samples: stat.pulls, totalReward, averageReward: stat.avgReward }
    state.totalSamples += stat.pulls
  }
  return state
}

function parsePersistedSchedulerReward(json: string): { arm: TeamSchedulerArm; reward: number } | null {
  try {
    const record = JSON.parse(json) as { arm?: unknown; reward?: unknown }
    if (!SCHEDULER_ARMS.includes(record.arm as TeamSchedulerArm)) return null
    if (typeof record.reward !== 'number' || !Number.isFinite(record.reward)) return null
    return { arm: record.arm as TeamSchedulerArm, reward: clampReward(record.reward) }
  } catch {
    return null
  }
}

export function buildHistoricalTeamSchedulerState(
  store: TeamSchedulerRewardSummaryStore | undefined | null,
  limit = 200,
): TeamSchedulerBanditState {
  const state = emptyTeamSchedulerState()
  if (!store?.loadBanditStatesByPrefix) return state
  const rows = store.loadBanditStatesByPrefix('team_scheduler_reward:', limit)
  for (const row of rows) {
    const parsed = parsePersistedSchedulerReward(row.json)
    if (!parsed) continue
    const current = state.arms[parsed.arm]
    current.samples += 1
    current.totalReward += parsed.reward
    current.averageReward = current.totalReward / current.samples
    state.totalSamples += 1
  }
  return state
}
