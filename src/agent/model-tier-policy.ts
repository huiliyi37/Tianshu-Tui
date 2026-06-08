import type { ModelCapabilityCard } from '../model/capability.js'
import type { WorkOrderKind, WorkerProfile } from './work-order.js'

export type ModelTier = 'cheap' | 'balanced' | 'strong'
export type ModelRiskTier = 'low' | 'medium' | 'high'

export interface ModelTierPolicyInput {
  authority?: string
  profile: WorkerProfile
  kind: WorkOrderKind
  riskTier?: ModelRiskTier
  objective: string
  consecutiveFailures?: number
}

export interface ModelTierRecommendation {
  tier: ModelTier
  reason: string
  hardFloor?: 'balanced' | 'strong'
}

function normalized(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_')
}

function isExploration(input: Pick<ModelTierPolicyInput, 'kind' | 'profile' | 'objective'>): boolean {
  const objective = input.objective.toLowerCase()
  return input.kind === 'code_search' ||
    input.kind === 'doc_research' ||
    input.kind === 'plan' ||
    input.profile === 'code_scout' ||
    input.profile === 'doc_scout' ||
    /explor|research|调查|调研|搜索|规划|plan/.test(objective)
}

export function recommendModelTier(input: ModelTierPolicyInput): ModelTierRecommendation {
  const authority = normalized(input.authority)
  const riskTier = input.riskTier ?? 'medium'
  const consecutiveFailures = Math.max(0, Math.floor(input.consecutiveFailures ?? 0))

  if (consecutiveFailures >= 2) {
    return { tier: 'strong', hardFloor: 'strong', reason: 'repeated failure escalates worker tier to strong' }
  }

  if ((authority === 'tianquan' || authority === '天权') &&
    (input.profile === 'reviewer' || input.profile === 'adversarial_verifier')) {
    return { tier: 'strong', hardFloor: 'strong', reason: 'tianquan reviewer/verifier has false-green hard floor' }
  }

  if (input.kind === 'verify' || input.profile === 'verifier' || input.profile === 'adversarial_verifier') {
    return { tier: 'strong', hardFloor: 'strong', reason: 'verification work requires strong model tier' }
  }

  if (authority === 'tianfu' || authority === '天府') {
    if (riskTier === 'high') return { tier: 'strong', hardFloor: 'strong', reason: 'tianfu high-risk guardrail work uses strong tier' }
    return { tier: 'balanced', hardFloor: 'balanced', reason: 'tianfu guardrail work should not be cheap by default' }
  }

  if (authority === 'tianxuan' || authority === '天璇') {
    if (riskTier === 'high') return { tier: 'strong', hardFloor: 'strong', reason: 'tianxuan high-risk exploration needs strong reasoning' }
    return { tier: 'balanced', hardFloor: 'balanced', reason: 'tianxuan exploration/planning uses balanced tier' }
  }

  if (input.profile === 'code_scout' || input.profile === 'doc_scout') {
    return { tier: 'cheap', reason: 'read-only scout work is safe to observe as cheap tier' }
  }

  if ((authority === 'tianliang' || authority === '天梁') && input.profile === 'patcher') {
    if (riskTier === 'low') return { tier: 'cheap', reason: 'tianliang low-risk patcher can be observed as cheap tier' }
    if (riskTier === 'high') return { tier: 'balanced', hardFloor: 'balanced', reason: 'high-risk patcher should not be recommended cheap' }
    return { tier: 'balanced', reason: 'medium-risk patcher uses balanced tier' }
  }

  if (riskTier === 'high') return { tier: 'strong', hardFloor: 'strong', reason: 'high-risk work uses strong tier by default' }
  if (isExploration(input)) return { tier: 'cheap', reason: 'low-impact exploration defaults to cheap tier' }
  return { tier: 'balanced', reason: 'default worker tier is balanced' }
}

export function inferModelTierFromCard(card: Pick<ModelCapabilityCard, 'model' | 'contextWindow' | 'toolUseReliability' | 'jsonStability' | 'editSuccessRate' | 'testRepairRate'>): ModelTier {
  const name = card.model.toLowerCase()
  if (/\b(flash|mini|lite|cheap|small|haiku)\b|m2/.test(name)) return 'cheap'
  if (/\b(pro|strong|large|opus|max|ultra)\b|gpt-5/.test(name)) return 'strong'

  const capabilityAverage = (
    clampUnit(card.toolUseReliability) +
    clampUnit(card.jsonStability) +
    clampUnit(card.editSuccessRate) +
    clampUnit(card.testRepairRate)
  ) / 4

  if (capabilityAverage >= 0.82 || card.contextWindow >= 800_000) return 'strong'
  if (capabilityAverage <= 0.55 && card.contextWindow <= 256_000) return 'cheap'
  return 'balanced'
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}
