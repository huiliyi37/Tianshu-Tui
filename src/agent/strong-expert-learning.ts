/**
 * Strong Expert Agent（SEA）路由学习账本 —— P2e。
 *
 * 纪律对齐 model-tier-shadow/gate：
 *  - 先 shadow：样本不足 / 奖励边际不足 / 特性旗标关闭时，只记账不改变路由。
 *  - 后 gate：同 momentKind 下候选专家通过率显著高于静态规则专家时才转正。
 *  - 基础设施失败（failureReason）不记入能力胜率；账本故障永远 fail-open 回静态规则。
 */

import type { CriticalMomentKind, StrongExpertId } from './strong-expert.js'

export const STRONG_EXPERT_ROUTING_PREFIX = 'strong_expert_routing:'

export const MIN_STRONG_EXPERT_TOTAL_SAMPLES = 20
export const MIN_STRONG_EXPERT_ARM_SAMPLES = 5
export const STRONG_EXPERT_REWARD_MARGIN = 0.05

export interface StrongExpertRoutingRecord {
  schemaVersion: 1
  sessionId: string
  expert: StrongExpertId
  /** 触发该次召唤的关键时刻；显式召唤且未声明 trigger 时记 'direct'。 */
  momentKind: CriticalMomentKind | 'direct'
  status: 'passed' | 'failed' | 'blocked'
  model?: string
  /** input+output token 合计（每通过成本维度）。 */
  costTokens?: number
  /** 基础设施失败（timeout/max_turns/crash…）不可归因到专家能力，统计剔除。 */
  failureReason?: string
  timestamp: number
}

export interface StrongExpertRoutingStore {
  saveBanditState?(kind: string, json: string): void
  loadBanditStatesByPrefix?(prefix: string, limit?: number): Array<{ kind: string; json: string }>
}

export interface StrongExpertArmStat {
  samples: number
  passed: number
  averageReward: number
  costTokens: number
}

export interface StrongExpertLearningState {
  totalSamples: number
  arms: Record<string, StrongExpertArmStat>
}

export function strongExpertRoutingKind(record: Pick<StrongExpertRoutingRecord, 'sessionId' | 'timestamp'>): string {
  return `${STRONG_EXPERT_ROUTING_PREFIX}${record.sessionId}:${record.timestamp}`
}

function validStatus(v: unknown): v is StrongExpertRoutingRecord['status'] {
  return v === 'passed' || v === 'failed' || v === 'blocked'
}

function parseRecord(value: unknown): StrongExpertRoutingRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (r.schemaVersion !== 1) return null
  if (typeof r.sessionId !== 'string' || typeof r.expert !== 'string' || typeof r.momentKind !== 'string') return null
  if (!validStatus(r.status) || typeof r.timestamp !== 'number') return null
  return {
    schemaVersion: 1,
    sessionId: r.sessionId,
    expert: r.expert as StrongExpertId,
    momentKind: r.momentKind as StrongExpertRoutingRecord['momentKind'],
    status: r.status,
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
    ...(typeof r.costTokens === 'number' && Number.isFinite(r.costTokens) ? { costTokens: r.costTokens } : {}),
    ...(typeof r.failureReason === 'string' ? { failureReason: r.failureReason } : {}),
    timestamp: r.timestamp,
  }
}

/** 账本写侧：追加一条 SEA 路由事实。best-effort，绝不影响派发。 */
export function recordStrongExpertRouting(
  store: StrongExpertRoutingStore | undefined | null,
  input: Omit<StrongExpertRoutingRecord, 'schemaVersion' | 'timestamp'> & { timestamp?: number },
): void {
  if (!store?.saveBanditState) return
  const record: StrongExpertRoutingRecord = {
    schemaVersion: 1,
    ...input,
    timestamp: input.timestamp ?? Date.now(),
  }
  try {
    store.saveBanditState(strongExpertRoutingKind(record), JSON.stringify(record))
  } catch {
    // 路由学习绝不能影响专家召唤。
  }
}

/** 从 MeridianDb p3_state 读取 SEA 路由记录（前缀扫描 + 结构校验）。 */
export function loadStrongExpertRecords(
  store: StrongExpertRoutingStore | undefined | null,
  limit = 500,
): StrongExpertRoutingRecord[] {
  if (!store?.loadBanditStatesByPrefix) return []
  try {
    return store
      .loadBanditStatesByPrefix(STRONG_EXPERT_ROUTING_PREFIX, limit)
      .map(row => {
        try { return parseRecord(JSON.parse(row.json)) } catch { return null }
      })
      .filter((r): r is StrongExpertRoutingRecord => r !== null)
  } catch {
    return []
  }
}

export function emptyStrongExpertLearningState(): StrongExpertLearningState {
  return { totalSamples: 0, arms: {} }
}

function armKey(expert: StrongExpertId, momentKind: CriticalMomentKind | 'direct'): string {
  return `${expert}::${momentKind}`
}

/** 汇总记录为 arm 统计：基础设施失败剔除（不污染能力胜率）。 */
export function summarizeStrongExpertLearning(records: StrongExpertRoutingRecord[]): StrongExpertLearningState {
  const state = emptyStrongExpertLearningState()
  for (const record of records) {
    if (record.failureReason) continue
    const key = armKey(record.expert, record.momentKind)
    const arm = state.arms[key] ?? { samples: 0, passed: 0, averageReward: 0, costTokens: 0 }
    arm.samples++
    if (record.status === 'passed') arm.passed++
    arm.costTokens += record.costTokens ?? 0
    arm.averageReward = arm.passed / arm.samples
    state.arms[key] = arm
    state.totalSamples++
  }
  return state
}

export interface StrongExpertGateDecision {
  gateOpen: boolean
  applied: boolean
  expert: StrongExpertId
  reason: string
  evidenceWindow: Record<string, number | string | boolean>
  vetoSignals: string[]
}

/** 某 momentKind 下的样本总数（跨专家）。闸门口径（2026-09-02 修正）：按
 *  momentKind 计数而非全局——A 类时刻的闸门不能被 B 类时刻攒的样本解锁。 */
function kindSampleCount(state: StrongExpertLearningState, momentKind: CriticalMomentKind | 'direct'): number {
  let total = 0
  for (const [key, arm] of Object.entries(state.arms)) {
    if (key.endsWith(`::${momentKind}`)) total += arm.samples
  }
  return total
}

/**
 * shadow→gate：在 momentKind 下比较候选专家与静态规则专家。
 * 候选集合由调用方提供（先验顺序）；只有候选 arm 样本与边际都达标才开门。
 * 两道防污染闸（2026-09-02 修正）：
 *  - 样本门槛按 momentKind 计数，跨 kind 全局计数会虚假解锁；
 *  - 规则 arm 自身必须有最低观测——零观测时 ruleAvg 缺省 0，候选 1/5 即可
 *    「显著胜出」，比较无意义。
 */
export function evaluateStrongExpertGate(input: {
  state: StrongExpertLearningState
  momentKind: CriticalMomentKind | 'direct'
  ruleExpert: StrongExpertId
  candidates: readonly StrongExpertId[]
  featureFlagEnabled?: boolean
}): StrongExpertGateDecision {
  const rule = input.state.arms[armKey(input.ruleExpert, input.momentKind)]
  const ruleSamples = rule?.samples ?? 0
  const ruleAvg = rule?.averageReward ?? 0
  const kindSamples = kindSampleCount(input.state, input.momentKind)

  const shadow = (reason: string, vetoSignals: string[], evidence: Record<string, number | string | boolean> = {}): StrongExpertGateDecision => ({
    gateOpen: false,
    applied: false,
    expert: input.ruleExpert,
    reason,
    evidenceWindow: {
      source: 'strong_expert_routing',
      totalSamples: input.state.totalSamples,
      kindSamples,
      minTotalSamples: MIN_STRONG_EXPERT_TOTAL_SAMPLES,
      momentKind: input.momentKind,
      ruleExpert: input.ruleExpert,
      ruleSamples,
      minArmSamples: MIN_STRONG_EXPERT_ARM_SAMPLES,
      featureFlagEnabled: input.featureFlagEnabled === true,
      ...evidence,
    },
    vetoSignals,
  })

  if (kindSamples < MIN_STRONG_EXPERT_TOTAL_SAMPLES) {
    return shadow(`shadow: ${input.momentKind} samples ${kindSamples}/${MIN_STRONG_EXPERT_TOTAL_SAMPLES}`, ['insufficient_samples'])
  }

  if (ruleSamples < MIN_STRONG_EXPERT_ARM_SAMPLES) {
    return shadow(`shadow: rule arm ${input.ruleExpert} under-observed (${ruleSamples}/${MIN_STRONG_EXPERT_ARM_SAMPLES})`, ['rule_arm_under_observed'])
  }

  let bestExpert: StrongExpertId | null = null
  let bestAvg = -Infinity
  for (const expert of input.candidates) {
    const arm = input.state.arms[armKey(expert, input.momentKind)]
    if (!arm || arm.samples < MIN_STRONG_EXPERT_ARM_SAMPLES) continue
    if (arm.averageReward > bestAvg) {
      bestAvg = arm.averageReward
      bestExpert = expert
    }
  }

  if (!bestExpert || bestExpert === input.ruleExpert) {
    return shadow(`shadow: no learned arm beats the rule expert (best=${bestExpert ?? 'none'})`, ['no_learned_advantage'])
  }

  const margin = bestAvg - ruleAvg
  if (margin < STRONG_EXPERT_REWARD_MARGIN) {
    return shadow(`shadow: reward margin ${margin.toFixed(3)} < ${STRONG_EXPERT_REWARD_MARGIN}`, ['reward_margin'], {
      candidateExpert: bestExpert,
      candidateAvg: bestAvg,
      rewardMargin: Number(margin.toFixed(3)),
    })
  }

  if (input.featureFlagEnabled !== true) {
    return {
      ...shadow(`shadow: feature flag disabled (learned candidate ${bestExpert})`, ['explicit_flag_closed'], {
        candidateExpert: bestExpert,
        candidateAvg: bestAvg,
        rewardMargin: Number(margin.toFixed(3)),
      }),
      gateOpen: true,
    }
  }

  return {
    gateOpen: true,
    applied: true,
    expert: bestExpert,
    reason: `applied: ${bestExpert} beats ${input.ruleExpert} by ${margin.toFixed(3)}`,
    evidenceWindow: {
      source: 'strong_expert_routing',
      totalSamples: input.state.totalSamples,
      kindSamples,
      minTotalSamples: MIN_STRONG_EXPERT_TOTAL_SAMPLES,
      momentKind: input.momentKind,
      ruleExpert: input.ruleExpert,
      ruleSamples,
      minArmSamples: MIN_STRONG_EXPERT_ARM_SAMPLES,
      candidateExpert: bestExpert,
      candidateAvg: bestAvg,
      rewardMargin: Number(margin.toFixed(3)),
      featureFlagEnabled: true,
    },
    vetoSignals: [],
  }
}

/** 每个 momentKind 的候选专家集（只读诊断席；写席永不参与探索）。 */
export const STRONG_EXPERT_CANDIDATES: Record<CriticalMomentKind, StrongExpertId[]> = {
  'repeated-failure': ['root_cause', 'adversarial'],
  'verification-broken': ['root_cause', 'adversarial'],
  'gate-failed': ['root_cause', 'architecture'],
  'review-rejected': ['adversarial', 'architecture'],
  'scope-leak': ['architecture', 'root_cause'],
  'context-pressure': ['root_cause', 'architecture'],
  'convergence-plateau': ['architecture', 'root_cause'],
  'cross-module-blast': ['architecture', 'design'],
}

/**
 * 学习路由入口：gate applied 时覆盖静态建议；否则恒返回 ruleExpert。
 * 纯函数，任何脏 state/缺样本都降级为静态路由。
 */
export function recommendStrongExpertForMoment(
  state: StrongExpertLearningState | undefined,
  momentKind: CriticalMomentKind,
  ruleExpert: StrongExpertId,
  featureFlagEnabled?: boolean,
): StrongExpertId {
  if (!state || state.totalSamples === 0) return ruleExpert
  const decision = evaluateStrongExpertGate({
    state,
    momentKind,
    ruleExpert,
    candidates: STRONG_EXPERT_CANDIDATES[momentKind] ?? [ruleExpert],
    featureFlagEnabled,
  })
  return decision.applied ? decision.expert : ruleExpert
}
