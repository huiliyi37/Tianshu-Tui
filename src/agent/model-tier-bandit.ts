import type { RewardClosureRecord } from './reward-loop.js'
import type { ModelTier } from './model-tier-policy.js'
import type { TeamScopeHealthSeverity } from './team-scope-health.js'

export type ModelTierArm = `tier:${ModelTier}`

export interface ModelTierBanditArmState {
  samples: number
  totalReward: number
  averageReward: number
}

export interface ModelTierBanditState {
  totalSamples: number
  arms: Record<ModelTierArm, ModelTierBanditArmState>
  recentFalseGreenRate: number
  worstScopeHealthSeverity?: TeamScopeHealthSeverity
}

export interface ModelTierBanditRecommendation {
  arm: ModelTierArm
  tier: ModelTier
  score: number
  confidence: number
  reason: string
}

export interface ModelTierBanditStore {
  loadBanditStatesByPrefix?(prefix: string, limit?: number): Array<{ kind: string; json: string }>
}

export interface BuildHistoricalModelTierStateOptions {
  limitPerPrefix?: number
}

interface ParsedTierShadow {
  actualModel: string
  actualTier: ModelTier
}

interface ParsedScopeHealth {
  severity: TeamScopeHealthSeverity
}

const MODEL_TIERS: ModelTier[] = ['cheap', 'balanced', 'strong']
const MODEL_TIER_ARMS: ModelTierArm[] = ['tier:cheap', 'tier:balanced', 'tier:strong']
const REWARD_CLOSURE_PREFIXES = [
  'reward_closure:team_wave:',
  'reward_closure:team_episode:',
] as const

function clampReward(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(-1, value))
}

function emptyArm(): ModelTierBanditArmState {
  return { samples: 0, totalReward: 0, averageReward: 0 }
}

export function emptyModelTierBanditState(): ModelTierBanditState {
  return {
    totalSamples: 0,
    arms: {
      'tier:cheap': emptyArm(),
      'tier:balanced': emptyArm(),
      'tier:strong': emptyArm(),
    },
    recentFalseGreenRate: 0,
  }
}

export function allModelTierArms(): ModelTierArm[] {
  return [...MODEL_TIER_ARMS]
}

export function modelTierArmForTier(tier: ModelTier): ModelTierArm {
  return `tier:${tier}`
}

export function tierForModelTierArm(arm: ModelTierArm): ModelTier {
  return arm.slice('tier:'.length) as ModelTier
}

function isModelTier(value: unknown): value is ModelTier {
  return MODEL_TIERS.includes(value as ModelTier)
}

function stringComponent(components: Record<string, number | boolean | string>, key: string): string | null {
  const value = components[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function booleanComponent(components: Record<string, number | boolean | string>, key: string): boolean {
  return components[key] === true
}

function scopeSeverityRank(severity: TeamScopeHealthSeverity | undefined): number {
  switch (severity) {
    case 'high': return 3
    case 'medium': return 2
    case 'low': return 1
    case 'healthy': return 0
    default: return -1
  }
}

function parseScopeSeverity(value: unknown): TeamScopeHealthSeverity | undefined {
  return value === 'healthy' || value === 'low' || value === 'medium' || value === 'high' ? value : undefined
}

function updateWorstScopeHealth(state: ModelTierBanditState, severity: TeamScopeHealthSeverity | undefined): void {
  if (!severity) return
  if (scopeSeverityRank(severity) > scopeSeverityRank(state.worstScopeHealthSeverity)) {
    state.worstScopeHealthSeverity = severity
  }
}

function parseTierShadow(json: string): ParsedTierShadow | null {
  try {
    const parsed = JSON.parse(json) as { schemaVersion?: unknown; actualModel?: unknown; actualTier?: unknown }
    if (parsed.schemaVersion !== 1) return null
    if (typeof parsed.actualModel !== 'string' || parsed.actualModel.trim().length === 0) return null
    if (!isModelTier(parsed.actualTier)) return null
    return { actualModel: parsed.actualModel, actualTier: parsed.actualTier }
  } catch {
    return null
  }
}

function parseRewardClosure(json: string): RewardClosureRecord | null {
  try {
    const parsed = JSON.parse(json) as Partial<RewardClosureRecord>
    if (parsed.schemaVersion !== 1) return null
    if (parsed.sourceKind !== 'team_wave' && parsed.sourceKind !== 'team_episode') return null
    if (typeof parsed.reward !== 'number' || !Number.isFinite(parsed.reward)) return null
    if (!parsed.components || typeof parsed.components !== 'object') return null
    return parsed as RewardClosureRecord
  } catch {
    return null
  }
}

function parseScopeHealth(json: string): ParsedScopeHealth | null {
  try {
    const parsed = JSON.parse(json) as { schemaVersion?: unknown; severity?: unknown }
    if (parsed.schemaVersion !== 1) return null
    const severity = parseScopeSeverity(parsed.severity)
    return severity ? { severity } : null
  } catch {
    return null
  }
}

function severityFromNormalizedScopeLeak(value: unknown): TeamScopeHealthSeverity | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? 'medium' : undefined
}

function rewardTier(record: RewardClosureRecord, modelTierByModel: Map<string, ModelTier>): ModelTier | null {
  const directTier = stringComponent(record.components, 'workerTier') ?? stringComponent(record.components, 'selectedTier')
  if (isModelTier(directTier)) return directTier

  const workerModel = stringComponent(record.components, 'workerModel')
  if (!workerModel) return null
  return modelTierByModel.get(workerModel) ?? null
}

function addReward(state: ModelTierBanditState, tier: ModelTier, reward: number): void {
  const arm = state.arms[modelTierArmForTier(tier)]
  arm.samples += 1
  arm.totalReward += clampReward(reward)
  arm.averageReward = arm.totalReward / arm.samples
  state.totalSamples += 1
}

export function buildHistoricalModelTierState(
  store: ModelTierBanditStore | undefined | null,
  options: BuildHistoricalModelTierStateOptions = {},
): ModelTierBanditState {
  const state = emptyModelTierBanditState()
  if (!store?.loadBanditStatesByPrefix) return state

  const limit = options.limitPerPrefix ?? 200
  const modelTierByModel = new Map<string, ModelTier>()
  for (const row of store.loadBanditStatesByPrefix('model_tier_shadow:', limit)) {
    const parsed = parseTierShadow(row.json)
    if (!parsed) continue
    modelTierByModel.set(parsed.actualModel, parsed.actualTier)
  }

  for (const row of store.loadBanditStatesByPrefix('team_scope_health:', limit)) {
    const parsed = parseScopeHealth(row.json)
    if (!parsed) continue
    updateWorstScopeHealth(state, parsed.severity)
  }

  for (const prefix of REWARD_CLOSURE_PREFIXES) {
    for (const row of store.loadBanditStatesByPrefix(prefix, limit)) {
      const record = parseRewardClosure(row.json)
      if (!record) continue
      if (booleanComponent(record.components, 'falseGreen')) {
        state.recentFalseGreenRate = 1
        continue
      }
      updateWorstScopeHealth(state, parseScopeSeverity(record.components.scopeSeverity))
      updateWorstScopeHealth(state, severityFromNormalizedScopeLeak(record.components.normalizedScopeLeak))
      const tier = rewardTier(record, modelTierByModel)
      if (!tier) continue
      addReward(state, tier, record.reward)
    }
  }

  return state
}

export function recommendModelTierArm(state: ModelTierBanditState): ModelTierBanditRecommendation {
  const ranked = allModelTierArms()
    .map(arm => ({ arm, stat: state.arms[arm] }))
    .sort((a, b) => b.stat.averageReward - a.stat.averageReward || b.stat.samples - a.stat.samples)
  const best = ranked[0]!
  const tier = tierForModelTierArm(best.arm)
  const confidence = state.totalSamples <= 0 ? 0 : best.stat.samples / state.totalSamples
  return {
    arm: best.arm,
    tier,
    score: best.stat.averageReward,
    confidence,
    reason: best.stat.samples > 0
      ? `historical reward prefers ${best.arm} avg=${best.stat.averageReward.toFixed(3)} samples=${best.stat.samples}`
      : 'shadow: no historical reward evidence',
  }
}
