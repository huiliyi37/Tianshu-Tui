/**
 * Strong Expert Agent（SEA）——专家代理路由。
 *
 * 「强」不是模型档位：SEA = baseProfile（工具面）+ authority（星域视角）+
 * methodPacks（方法论胶囊/战绩账本）+ toolGrants（专家额外工具）+ 独立上下文。
 * 主控保持轻量，专家在 CriticalMoment 被召唤、在独立会话里深潜。
 *
 * P2a/P2b：静态 manifest + 纯函数关键时刻检测。不新增写行为；写席 surgeon
 * 仅定义不开放（allowSurgeon 默认 false）。
 */

import type { WorkerProfile } from './work-order.js'

export type StrongExpertId =
  | 'root_cause'
  | 'architecture'
  | 'adversarial'
  | 'design'
  | 'surgeon'

export type CriticalMomentKind =
  | 'repeated-failure'
  | 'verification-broken'
  | 'gate-failed'
  | 'review-rejected'
  | 'scope-leak'
  | 'context-pressure'
  | 'convergence-plateau'
  | 'cross-module-blast'

export interface StrongExpertMethodPacks {
  /** recall_capsule 的星名（中文封存名，与 seed-capsule-store 对齐）。 */
  capsules: string[]
  /** recall_general 的将星名（中文星名）。 */
  generals: string[]
}

export interface StrongExpertManifest {
  id: StrongExpertId
  label: string
  baseProfile: WorkerProfile
  authority: string
  methodPacks: StrongExpertMethodPacks
  /** 在 profile.allowedTools 之上追加的专家工具（工单层 union 后仍过 authority 白名单）。 */
  toolGrants: string[]
  triggers: CriticalMomentKind[]
  /** 只读诊断席可 auto；写席永远 false。 */
  autoDispatch: boolean
  /** 写席标记——首批默认 fail-closed，不开放 surgeon。 */
  write: boolean
  kind: 'code_search' | 'doc_research' | 'plan' | 'review' | 'verify' | 'patch_proposal'
  modelPolicy: { tierFloor?: 'cheap' | 'balanced' }
  /** maxTokens = 专家驻场上下文预算：resume 载入超限时从最旧侧裁剪
   *  （coordinator → trimMessagesToTokenBudget 消费）；同时是收尾/修复轮的
   *  输出上限（worker-session 侧钳 ≤16384，输出不需要 32k）。 */
  budget: { maxTurns?: number; timeoutMs?: number; maxTokens?: number }
  description: string
}

export const STRONG_EXPERTS: Readonly<Record<StrongExpertId, StrongExpertManifest>> = {
  root_cause: {
    id: 'root_cause',
    label: '根因诊断席',
    baseProfile: 'troubleshooter',
    authority: 'tianji',
    methodPacks: {
      capsules: ['诊断阶梯', '攻坚方法论'],
      generals: ['天机'],
    },
    toolGrants: ['recall_capsule', 'recall_general', 'run_tests'],
    triggers: ['repeated-failure', 'verification-broken', 'gate-failed', 'convergence-plateau'],
    autoDispatch: true,
    write: false,
    kind: 'code_search',
    modelPolicy: { tierFloor: 'balanced' },
    budget: { maxTurns: 32, timeoutMs: 600_000, maxTokens: 32768 },
    description: '定位根因并给出最小修复方案；只读 + 可运行测试复现，不修改文件。',
  },
  architecture: {
    id: 'architecture',
    label: '架构席',
    baseProfile: 'architect',
    authority: 'tianquan',
    methodPacks: {
      capsules: ['知识工作'],
      generals: ['天权'],
    },
    toolGrants: ['recall_capsule', 'recall_general'],
    triggers: ['scope-leak', 'cross-module-blast'],
    autoDispatch: true,
    write: false,
    kind: 'review',
    modelPolicy: { tierFloor: 'balanced' },
    budget: { maxTurns: 24, timeoutMs: 600_000, maxTokens: 16384 },
    description: '模块边界/耦合/依赖方向审查，给出按爆炸半径排序的重构建议。',
  },
  adversarial: {
    id: 'adversarial',
    label: '对抗验证席',
    baseProfile: 'adversarial_verifier',
    authority: 'yaoguang',
    methodPacks: {
      capsules: ['诊断阶梯'],
      generals: ['瑶光'],
    },
    toolGrants: ['recall_capsule', 'recall_general', 'ast_grep'],
    triggers: ['review-rejected', 'scope-leak'],
    autoDispatch: true,
    write: false,
    kind: 'verify',
    modelPolicy: { tierFloor: 'balanced' },
    budget: { maxTurns: 32, timeoutMs: 600_000, maxTokens: 32768 },
    description: '独立复现与对抗验证；产出证据包与假绿判定，不修改文件。',
  },
  design: {
    id: 'design',
    label: '设计席',
    baseProfile: 'designer',
    authority: 'wenqu',
    methodPacks: {
      capsules: ['设计审美'],
      generals: [],
    },
    toolGrants: ['recall_capsule'],
    triggers: ['cross-module-blast'],
    autoDispatch: false,
    write: false,
    kind: 'review',
    modelPolicy: {},
    budget: { maxTurns: 24, timeoutMs: 600_000, maxTokens: 16384 },
    description: 'UI/UX 设计批评与方向提议，只读。',
  },
  surgeon: {
    id: 'surgeon',
    label: '手术席（写）',
    baseProfile: 'patcher',
    authority: 'tianliang',
    methodPacks: {
      capsules: ['诊断阶梯', '攻坚方法论'],
      generals: ['天梁'],
    },
    toolGrants: ['recall_capsule', 'recall_general', 'record_general_finding'],
    triggers: ['repeated-failure', 'verification-broken'],
    autoDispatch: false,
    write: true,
    kind: 'patch_proposal',
    modelPolicy: { tierFloor: 'balanced' },
    budget: { maxTurns: 48, timeoutMs: 900_000, maxTokens: 49152 },
    description: '在 root_cause 给出根因且主控批准后，按明确 file scope 动手修复。',
  },
} as const

export function resolveStrongExpert(id: string): StrongExpertManifest | null {
  return STRONG_EXPERTS[id as StrongExpertId] ?? null
}

export function listStrongExpertIds(): StrongExpertId[] {
  return Object.keys(STRONG_EXPERTS) as StrongExpertId[]
}

export interface CriticalMomentEvidence {
  tool?: string
  target?: string
  fingerprint?: string
  commands?: string[]
  changedFiles?: string[]
}

export interface CriticalMoment {
  kind: CriticalMomentKind
  evidence: CriticalMomentEvidence
  suggestedExpert: StrongExpertId
  /** 写席永远 false；只读诊断席按 manifest.autoDispatch。 */
  auto: boolean
}

export interface CriticalMomentSnapshot {
  doomLoopLevel: 'none' | 'warn' | 'blocked'
  /** 同 tool+target 失败指纹的重复次数（未达阈值可不传）。 */
  repeatedToolFailures?: number
  typecheckBroken?: boolean
  waveGateFailed?: boolean
  reviewRejected?: boolean
  scopeLeakedFiles?: string[]
  contextPressureRatio?: number
  convergencePlateau?: boolean
  crossModuleBlast?: string[]
}

const CONTEXT_PRESSURE_EXPERT_THRESHOLD = 0.7
const REPEATED_TOOL_FAILURE_THRESHOLD = 3

const TRIGGER_EXPERTS: Record<CriticalMomentKind, StrongExpertId> = {
  'repeated-failure': 'root_cause',
  'verification-broken': 'root_cause',
  'gate-failed': 'root_cause',
  'review-rejected': 'adversarial',
  'scope-leak': 'architecture',
  'context-pressure': 'root_cause',
  'convergence-plateau': 'architecture',
  'cross-module-blast': 'architecture',
}

/** P2e 学习路由注入点：返回 undefined 时回退静态映射。 */
export interface StrongExpertRouter {
  recommend(kind: CriticalMomentKind, ruleExpert: StrongExpertId): StrongExpertId
}

function routeExpert(
  kind: CriticalMomentKind,
  router: StrongExpertRouter | undefined,
): StrongExpertId {
  const rule = TRIGGER_EXPERTS[kind]
  return router?.recommend(kind, rule) ?? rule
}

/**
 * 从 turn 边界既有状态检测关键时刻。纯函数、无 IO；只做信号 → SEA 的静态
 * 映射。调用方负责把建议渲染成卡片（auto 只允许只读诊断席）。
 */
export function detectCriticalMoments(snapshot: CriticalMomentSnapshot, router?: StrongExpertRouter): CriticalMoment[] {
  const moments: CriticalMoment[] = []

  if (snapshot.doomLoopLevel === 'blocked' || snapshot.doomLoopLevel === 'warn') {
    moments.push({
      kind: 'repeated-failure',
      evidence: { fingerprint: snapshot.doomLoopLevel },
      suggestedExpert: routeExpert('repeated-failure', router),
      auto: STRONG_EXPERTS[TRIGGER_EXPERTS['repeated-failure']].autoDispatch,
    })
  }

  if ((snapshot.repeatedToolFailures ?? 0) >= REPEATED_TOOL_FAILURE_THRESHOLD) {
    moments.push({
      kind: 'repeated-failure',
      evidence: { fingerprint: `repeat:${snapshot.repeatedToolFailures}` },
      suggestedExpert: routeExpert('repeated-failure', router),
      auto: STRONG_EXPERTS[TRIGGER_EXPERTS['repeated-failure']].autoDispatch,
    })
  }

  if (snapshot.typecheckBroken) {
    moments.push({
      kind: 'verification-broken',
      evidence: {},
      suggestedExpert: routeExpert('verification-broken', router),
      auto: STRONG_EXPERTS[TRIGGER_EXPERTS['verification-broken']].autoDispatch,
    })
  }

  if (snapshot.waveGateFailed) {
    moments.push({
      kind: 'gate-failed',
      evidence: {},
      suggestedExpert: routeExpert('gate-failed', router),
      auto: STRONG_EXPERTS[TRIGGER_EXPERTS['gate-failed']].autoDispatch,
    })
  }

  if (snapshot.reviewRejected) {
    moments.push({
      kind: 'review-rejected',
      evidence: {},
      suggestedExpert: routeExpert('review-rejected', router),
      auto: STRONG_EXPERTS[TRIGGER_EXPERTS['review-rejected']].autoDispatch,
    })
  }

  if (snapshot.scopeLeakedFiles && snapshot.scopeLeakedFiles.length > 0) {
    moments.push({
      kind: 'scope-leak',
      evidence: { changedFiles: snapshot.scopeLeakedFiles },
      suggestedExpert: routeExpert('scope-leak', router),
      auto: STRONG_EXPERTS[TRIGGER_EXPERTS['scope-leak']].autoDispatch,
    })
  }

  if ((snapshot.contextPressureRatio ?? 0) >= CONTEXT_PRESSURE_EXPERT_THRESHOLD) {
    moments.push({
      kind: 'context-pressure',
      evidence: {},
      suggestedExpert: routeExpert('context-pressure', router),
      auto: STRONG_EXPERTS[TRIGGER_EXPERTS['context-pressure']].autoDispatch,
    })
  }

  if (snapshot.convergencePlateau) {
    moments.push({
      kind: 'convergence-plateau',
      evidence: {},
      suggestedExpert: routeExpert('convergence-plateau', router),
      auto: STRONG_EXPERTS[TRIGGER_EXPERTS['convergence-plateau']].autoDispatch,
    })
  }

  if (snapshot.crossModuleBlast && snapshot.crossModuleBlast.length > 0) {
    moments.push({
      kind: 'cross-module-blast',
      evidence: { changedFiles: snapshot.crossModuleBlast },
      suggestedExpert: routeExpert('cross-module-blast', router),
      auto: STRONG_EXPERTS[TRIGGER_EXPERTS['cross-module-blast']].autoDispatch,
    })
  }

  // 去重（同 kind 只保留第一条），保持信号顺序稳定。
  const seen = new Set<CriticalMomentKind>()
  return moments.filter(m => {
    if (seen.has(m.kind)) return false
    seen.add(m.kind)
    return true
  })
}

/** 写席守卫：surgeon 只在显式开启时可用（首批 fail-closed）。 */
export function assertStrongExpertDispatchable(manifest: StrongExpertManifest, allowSurgeon: boolean): void {
  if (manifest.write && !allowSurgeon) {
    throw new Error(`strong expert "${manifest.id}" 是写席，首批未开放——先由只读诊断席产出根因，主控确认后再开放。`)
  }
}

// ── Expert Bench 可观测性（P2d）────────────────────────────────────────
// 进程内按 sessionId 分桶的专家席统计。持久化账本（跨进程）由 P2e 的
// SEA × momentKind 路由学习闭环承担；这里只服务 Cockpit 专家席卡片。

export interface ExpertBenchStat {
  expert: StrongExpertId
  label: string
  summons: number
  resumeHits: number
  passed: number
  total: number
}

const benchStatsBySession = new Map<string, Map<StrongExpertId, ExpertBenchStat>>()

function benchKey(sessionId: string | undefined): string {
  return sessionId ?? '__unknown_session__'
}

function ensureBenchStat(sessionId: string | undefined, expert: StrongExpertId): ExpertBenchStat {
  let byExpert = benchStatsBySession.get(benchKey(sessionId))
  if (!byExpert) {
    byExpert = new Map()
    benchStatsBySession.set(benchKey(sessionId), byExpert)
  }
  let stat = byExpert.get(expert)
  if (!stat) {
    stat = { expert, label: STRONG_EXPERTS[expert].label, summons: 0, resumeHits: 0, passed: 0, total: 0 }
    byExpert.set(expert, stat)
  }
  return stat
}

export function recordExpertBench(
  sessionId: string | undefined,
  expert: StrongExpertId,
  outcome: { resumeHit: boolean; passed: number; total: number },
): void {
  const stat = ensureBenchStat(sessionId, expert)
  stat.summons++
  if (outcome.resumeHit) stat.resumeHits++
  stat.passed += outcome.passed
  stat.total += outcome.total
}

export function getExpertBenchStats(sessionId?: string): ExpertBenchStat[] {
  const byExpert = benchStatsBySession.get(benchKey(sessionId))
  if (!byExpert) return []
  return [...byExpert.values()].sort((a, b) => a.expert.localeCompare(b.expert))
}

/** 测试专用：清空驻场统计。 */
export function __resetExpertBenchForTest(): void {
  benchStatsBySession.clear()
}
