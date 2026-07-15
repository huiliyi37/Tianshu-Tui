import type { RewardClosureRecord } from './reward-loop.js'

export interface ModelRewardSummaryStore {
  loadBanditStatesByPrefix?(prefix: string, limit?: number): Array<{ kind: string; json: string }>
}

export interface BuildHistoricalModelRewardsOptions {
  limitPerKind?: number
}

interface RewardAccumulator {
  total: number
  count: number
}

const REWARD_CLOSURE_PREFIXES = [
  'reward_closure:routing_shadow:',
  'reward_closure:team_wave:',
  // W4-D2/D3: worker episodes carry a verified (main-side write gate) outcome
  // per worker model — highest-signal rows for future dispatch ranking.
  'reward_closure:worker_episode:',
] as const

function finiteReward(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(-1, value))
}

function stringComponent(components: Record<string, number | boolean | string>, key: string): string | null {
  const value = components[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function modelNamesForReward(record: RewardClosureRecord): string[] {
  if (record.sourceKind === 'routing_shadow') {
    const recommendedModel = stringComponent(record.components, 'recommendedModel')
    return recommendedModel ? [recommendedModel] : []
  }

  if (record.sourceKind === 'team_wave' || record.sourceKind === 'worker_episode') {
    // Current team-wave reward closure stores only workerModelCount, not per-worker
    // model identities. Keep this branch explicit so future richer closures can be
    // consumed without guessing from source keys or counts. Worker episodes always
    // carry a single workerModel.
    const workerModel = stringComponent(record.components, 'workerModel')
    return workerModel ? [workerModel] : []
  }

  return []
}

function parseRewardClosure(json: string): RewardClosureRecord | null {
  try {
    const parsed = JSON.parse(json) as Partial<RewardClosureRecord>
    if (parsed.schemaVersion !== 1) return null
    if (parsed.sourceKind !== 'routing_shadow' && parsed.sourceKind !== 'team_wave' && parsed.sourceKind !== 'worker_episode') return null
    if (!parsed.components || typeof parsed.components !== 'object') return null
    if (finiteReward(parsed.reward) === null) return null
    return parsed as RewardClosureRecord
  } catch {
    return null
  }
}

export function buildHistoricalModelRewards(
  store: ModelRewardSummaryStore | undefined | null,
  options: BuildHistoricalModelRewardsOptions = {},
): Record<string, number | undefined> {
  if (!store?.loadBanditStatesByPrefix) return {}

  const limitPerKind = options.limitPerKind ?? 100
  const accumulators = new Map<string, RewardAccumulator>()

  for (const prefix of REWARD_CLOSURE_PREFIXES) {
    const rows = store.loadBanditStatesByPrefix(prefix, limitPerKind)
    for (const row of rows) {
      const record = parseRewardClosure(row.json)
      if (!record) continue
      const reward = finiteReward(record.reward)
      if (reward === null) continue
      for (const model of modelNamesForReward(record)) {
        const current = accumulators.get(model) ?? { total: 0, count: 0 }
        current.total += reward
        current.count += 1
        accumulators.set(model, current)
      }
    }
  }

  const summary: Record<string, number | undefined> = {}
  for (const [model, acc] of accumulators) {
    if (acc.count > 0) summary[model] = Math.round((acc.total / acc.count) * 1_000_000) / 1_000_000
  }
  return summary
}
