import type { ModelCapabilityCard } from '../model/capability.js'
import type { WorkOrderKind, WorkerProfile } from './work-order.js'
import { profileRegistry } from './profile-registry.js'

export type ModelTier = 'cheap' | 'balanced' | 'strong'
export type ModelRiskTier = 'low' | 'medium' | 'high'

export interface ModelTierPolicyInput {
  authority?: string
  profile: WorkerProfile
  kind: WorkOrderKind
  riskTier?: ModelRiskTier
  objective: string
  consecutiveFailures?: number
  /** Config override for worker tier (config.workers.patcherTier).
   *  Bypasses riskTier-based routing — user explicitly picks the tier. */
  workerTierOverride?: ModelTier
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
  // tierLock: profile-level override that prevents all escalation (Flash army profiles)
  const profileDef = profileRegistry.get(input.profile)
  if (profileDef?.tierLock) {
    return { tier: profileDef.tierLock, reason: `profile ${input.profile} has tierLock=${profileDef.tierLock} — no escalation` }
  }

  const authority = normalized(input.authority)
  const riskTier = input.riskTier ?? 'medium'
  const consecutiveFailures = Math.max(0, Math.floor(input.consecutiveFailures ?? 0))

  if (consecutiveFailures >= 2) {
    return { tier: 'strong', hardFloor: 'strong', reason: 'repeated failure escalates worker tier to strong' }
  }

  if (input.kind === 'verify' || input.profile === 'verifier' || input.profile === 'adversarial_verifier') {
    return { tier: 'cheap', reason: 'verification work uses flash model for fast review throughput' }
  }

  // 规划模型独立路由：team max 三视角规划席默认走强档。base planner 产出即
  // 执行分片图，规划质量直接决定并行拆分好坏，故不当作便宜探索；hardFloor=strong
  // 确保 routing(workers.routing.planning→capable) 命中强档而非被便宜档过滤掉。
  // 想完全自定义 provider/tier 可配 review.profiles.perspective_planner（覆盖卡绕过档位过滤）。
  if (input.profile === 'perspective_planner') {
    return { tier: 'strong', hardFloor: 'strong', reason: 'planning model defaults to strong tier — base plan is the executable shard graph' }
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
    // flash 能力足以承担各级风险的天梁执行任务（会话 5158719d：原 riskTier 三档
    // 路由把 medium/high 踢到 balanced/strong，浪费生产力）。默认 cheap，不因
    // riskTier 预判降级；可经 agent.workers.patcherTier 配置覆盖（如设 'balanced'
    // 或 'strong' 用 Pro）。真撑不住时由 consecutiveFailures≥2 自动升 strong。
    if (input.workerTierOverride) {
      return { tier: input.workerTierOverride, reason: `tianliang patcher tier overridden by config: ${input.workerTierOverride}` }
    }
    return { tier: 'cheap', reason: 'tianliang patcher defaults to flash — capable enough for execution; escalates only on repeated failure' }
  }

  if (riskTier === 'high') return { tier: 'strong', hardFloor: 'strong', reason: 'high-risk work uses strong tier by default' }
  if (isExploration(input)) return { tier: 'cheap', reason: 'low-impact exploration defaults to cheap tier' }
  return { tier: 'cheap', reason: 'default worker tier is cheap (flash model)' }
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
