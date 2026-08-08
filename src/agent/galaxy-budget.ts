/**
 * Shared Galaxy scheduling metadata.
 *
 * Galaxy and Starflow must calculate the same worker fan-out. Keeping the
 * profile mapping and EP/DP expansion in one place prevents the outer
 * Starflow timeout from drifting away from the Galaxy execution plan.
 *
 * 维度名 → 语义是这里的**单一事实源**：profile / WorkOrderKind / taskShape 全部
 * 由 {@link classifyGalaxyDimension} 派生。此前 profile 与 kind 各有一张纯英文
 * 精确匹配表且兜底方向相反（kind→code_search 只读、profile→patcher 可写），
 * 中文维度名两表全落兜底，同一个 worker 拿到「有写权限 + 按只读任务把关」的
 * 矛盾组合：走 cheap 档写代码、绕过 patch_proposal 空壳检测、被套上探索类
 * maxFiles 上限、路由账本记成 explore。四条都是静默降级，观察者区分不出。
 */

import type { WorkOrderKind } from './work-order.js'

/** 维度语义类别——所有下游映射的唯一输入。 */
export type GalaxyDimensionSemantic = 'impl' | 'review' | 'verify' | 'plan' | 'docs' | 'search'

/** 任务形状（路由账本聚合键，5 值枚举保持不变以兼容既有记录）。 */
export type GalaxyTaskShape = 'impl' | 'review' | 'explore' | 'plan' | 'docs'

/**
 * 词根包含匹配，中英文并列。顺序即优先级，**只读语义在前、impl 兜底在后**：
 * 名字同时命中多类时（「审查实现质量」），判成只读的代价是权限收缩 + 明确失败，
 * 判成可写的代价是权限扩大 + 空壳静默通过——后者正是本表要修的失效形状。
 * docs 排在 plan 前，否则「调研可选方案」会被 plan 的「方案」抢先命中。
 */
const SEMANTIC_PATTERNS: ReadonlyArray<readonly [GalaxyDimensionSemantic, readonly string[]]> = [
  ['review', ['review', '审查', '评审', '复审', '审阅']],
  ['verify', ['verify', 'test', '验证', '回归', '测试', '自测']],
  ['docs', ['docs', 'doc', 'research', '文档', '调研', '研究', '资料']],
  ['plan', ['plan', 'design', '规划', '计划', '设计', '方案']],
  ['search', ['search', 'scout', 'explore', '检索', '搜索', '探查', '侦察', '探索', '调查']],
  ['impl', ['impl', 'patch', 'fix', 'frontend', 'backend', 'feature', '实现', '前端', '后端', '修复', '补丁', '开发', '重构']],
]

/** 归一化维度名并按词根分类；无命中时兜底 impl（与 patcher 兜底同向）。 */
export function classifyGalaxyDimension(name: string): GalaxyDimensionSemantic {
  const key = (name ?? '').toLowerCase().replace(/[\s_-]/g, '')
  if (key.length === 0) return 'impl'
  for (const [semantic, patterns] of SEMANTIC_PATTERNS) {
    for (const pattern of patterns) {
      if (key.includes(pattern)) return semantic
    }
  }
  return 'impl'
}

const PROFILE_BY_SEMANTIC: Readonly<Record<GalaxyDimensionSemantic, string>> = {
  review: 'reviewer',
  verify: 'reviewer',
  plan: 'planner',
  docs: 'doc_scout',
  search: 'code_scout',
  impl: 'patcher',
}

const KIND_BY_SEMANTIC: Readonly<Record<GalaxyDimensionSemantic, WorkOrderKind>> = {
  review: 'review',
  verify: 'verify',
  plan: 'plan',
  docs: 'doc_research',
  search: 'code_search',
  impl: 'patch_proposal',
}

const TASK_SHAPE_BY_SEMANTIC: Readonly<Record<GalaxyDimensionSemantic, GalaxyTaskShape>> = {
  review: 'review',
  verify: 'review',
  plan: 'plan',
  docs: 'docs',
  search: 'explore',
  impl: 'impl',
}

export interface GalaxyBudgetDimension {
  name?: string
  authority?: string
  authorities?: readonly string[]
  parallelism?: 'expert' | 'data'
  replicas?: number
  profile?: string
  tierFloor?: string
  timeoutMs?: number
}

export interface GalaxyBudgetInputs {
  profiles: Array<string | undefined>
  tierFloors: Array<string | undefined>
  requestedTimeoutMs: Array<number | undefined>
}

/** Resolve the default worker profile used by Galaxy for a dimension. */
export function mapGalaxyDimensionToProfile(name: string): string {
  return PROFILE_BY_SEMANTIC[classifyGalaxyDimension(name)]
}

/** Resolve the WorkOrderKind used by Galaxy for a dimension. */
export function mapGalaxyDimensionToKind(name: string): WorkOrderKind {
  return KIND_BY_SEMANTIC[classifyGalaxyDimension(name)]
}

/** Resolve the routing-ledger task shape for a dimension. */
export function mapGalaxyDimensionToTaskShape(name: string): GalaxyTaskShape {
  return TASK_SHAPE_BY_SEMANTIC[classifyGalaxyDimension(name)]
}

/** Whether a dimension is itself the explicit review wave. */
export function isReviewGalaxyDimension(name: string): boolean {
  const semantic = classifyGalaxyDimension(name)
  return semantic === 'review' || semantic === 'verify'
}

/** Expand dimensions into the worker-level timeout inputs used by Galaxy. */
export function buildGalaxyBudgetInputs(
  dimensions: readonly GalaxyBudgetDimension[],
): GalaxyBudgetInputs {
  const profiles: Array<string | undefined> = []
  const tierFloors: Array<string | undefined> = []
  const requestedTimeoutMs: Array<number | undefined> = []

  for (const rawDimension of dimensions) {
    // timeoutMs runs before Zod executes. Ignore malformed entries here so a
    // bad request still reaches the normal format_error response instead of
    // throwing while the tool pipeline is calculating its watchdog.
    if (!rawDimension || typeof rawDimension !== 'object') continue
    const dimension = rawDimension as GalaxyBudgetDimension
    const authorities = Array.isArray(dimension.authorities)
      ? dimension.authorities
      : (typeof dimension.authority === 'string' && dimension.authority.length > 0 ? [dimension.authority] : [])
    const replicas = dimension.parallelism === 'data' && typeof dimension.replicas === 'number' && Number.isFinite(dimension.replicas)
      ? Math.max(1, Math.trunc(dimension.replicas))
      : 1
    const profile = typeof dimension.profile === 'string'
      ? dimension.profile
      : (typeof dimension.name === 'string' && dimension.name.length > 0 ? mapGalaxyDimensionToProfile(dimension.name) : undefined)
    for (let i = 0; i < authorities.length * replicas; i++) {
      profiles.push(profile)
      tierFloors.push(dimension.tierFloor)
      requestedTimeoutMs.push(dimension.timeoutMs)
    }
  }

  return { profiles, tierFloors, requestedTimeoutMs }
}
