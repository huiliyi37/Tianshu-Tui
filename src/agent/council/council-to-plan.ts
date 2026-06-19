// W-C7 桥接：把 council 评审产物转成可执行 UnifiedPlan。
// 铁律：纯函数，零 I/O、零 Date（createdAt 复用 plan.meta.convenedAt 的确定时钟）。

import type { CouncilPlan } from './council-plan.js'
import type { UnifiedPlan, UnifiedTaskNode } from '../unified-plan.js'

type RiskTier = 'low' | 'medium' | 'high'
const SEVERITY_RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 }

/** 执行类 profile —— council 任务是代码改动，交给 patcher（role:hands, 写工具集）。 */
const EXECUTOR_PROFILE = 'patcher'

/**
 * CouncilPlan → UnifiedPlan（可经 team_orchestrate 的 planJson 直传执行）。
 *
 * 映射：
 *  - 每个 mergedItem → patch_proposal 任务节点；objective 取 detail（空则 title）。
 *  - files 来自席位只读工具定位（缺省空数组 = 全局任务，team 侧并行）。
 *  - riskTier 从各席 risks 按 itemId 聚合最高 severity；无关联默认 medium；
 *    泛化风险（无 itemId）不参与。
 *  - dependsOn 留空：council 任务表扁平，team 按 file 重叠自动分波。
 *  - rejected 决议 → nonGoals（留痕，下游知道哪些方向已被否）。
 *
 * 注：空 mergedItems 时产出 tasks 为空（validateUnifiedPlan 会判 invalid）——
 * 由调用方（council_convene）在产 planJson 前自行判空，本函数只做确定性映射。
 */
export function councilPlanToUnifiedPlan(plan: CouncilPlan): UnifiedPlan {
  const riskByItem = new Map<string, RiskTier>()
  for (const c of plan.contributions) {
    for (const r of c.risks) {
      if (!r.itemId) continue
      const prev = riskByItem.get(r.itemId)
      if (!prev || SEVERITY_RANK[r.severity] > SEVERITY_RANK[prev]) riskByItem.set(r.itemId, r.severity)
    }
  }

  const tasks: UnifiedTaskNode[] = plan.aggregate.mergedItems.map(item => ({
    id: item.id,
    title: item.title,
    objective: item.detail || item.title,
    profile: EXECUTOR_PROFILE,
    kind: 'patch_proposal',
    files: item.files ?? [],
    dependsOn: [],
    riskTier: riskByItem.get(item.id) ?? 'medium',
  }))

  const nonGoals = plan.aggregate.decisions
    .filter(d => d.verdict === 'rejected')
    .map(d => d.title)

  return {
    version: 1,
    objective: plan.objective,
    tasks,
    source: 'manual',
    createdAt: plan.meta.convenedAt,
    ...(nonGoals.length > 0 ? { nonGoals } : {}),
  }
}
