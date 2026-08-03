/**
 * 聚合策略中途达标判定器。每个 worker settle 时喂入与批末聚合同参的
 * verifyWorkerEvidence 输出，判定组/批是否已达标——达标后立即取消剩余
 * 兄弟 worker 以节省 token 与墙钟时间。
 *
 * 口径纪律：对每个 settle 结果跑与批末聚合（coordinator.ts → aggregation.ts）
 * 完全同参的 verifyWorkerEvidence(r, profile, undefined)，保证"短路时判达标
 * ⇒ 批末聚合也判达标"，不存在口径分歧。
 *
 * DP 义务守卫：quorum 组内 gated verified 计数 < k 且剩余未 settle 成员中
 * 存在能产 verified 的 profile（adversarial_verifier / goal_judge）→ 不短路
 * （等证据）；剩余成员全是普通只读 profile → 放行短路。
 */

import type { AggregationPolicy, WorkerResult, WorkOrder } from './work-order.js'
import { verifyWorkerEvidence, VERIFIED_CAPABLE_PROFILES } from './worker-evidence.js'
import { classifyProfile } from './coordination-policy.js'

export type ShortCircuitDecision =
  | { kind: 'none' }
  | { kind: 'cancel_all' }
  | { kind: 'cancel_group'; groupId: string }

export function cancelRestEnabled(): boolean {
  const v = process.env.RIVET_CANCEL_REST
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

/**
 * 聚合策略中途达标判定器。
 */
export class BatchShortCircuitJudge {
  private readonly gatedPassed = new Map<string, number>()
  private readonly gatedVerified = new Map<string, number>()
  private readonly settledIds = new Set<string>()
  private readonly firedGroups = new Set<string>()
  private allFired = false

  constructor(
    private readonly policy: AggregationPolicy,
    /** orderId → profile（批末聚合的同一份 profileMap） */
    private readonly profiles: Map<string, string>,
    /** groupId → 组内全部 orderId */
    private readonly groupMembers: Map<string, string[]>,
    /** orderId → groupId */
    private readonly groupOf: Map<string, string | undefined>,
    /** 组级 quorum 阈值（coordinator 已收集的 quorumGroups；缺省用 policy.k） */
    private readonly quorumGroups?: Map<string, number>,
  ) {}

  onSettle(raw: WorkerResult): ShortCircuitDecision {
    if (!cancelRestEnabled()) return { kind: 'none' }
    this.settledIds.add(raw.workOrderId)
    const profile = this.profiles.get(raw.workOrderId)
    const gated = verifyWorkerEvidence(raw, profile, undefined)

    if (this.policy === 'first_success') {
      if (this.allFired || gated.status !== 'passed') return { kind: 'none' }
      this.allFired = true
      return { kind: 'cancel_all' }
    }

    if (typeof this.policy === 'object' && this.policy.kind === 'quorum') {
      const groupId = this.groupOf.get(raw.workOrderId)
      if (groupId === undefined || this.firedGroups.has(groupId)) return { kind: 'none' }
      if (gated.status === 'passed') {
        this.gatedPassed.set(groupId, (this.gatedPassed.get(groupId) ?? 0) + 1)
      }
      if (gated.evidenceStatus === 'verified') {
        this.gatedVerified.set(groupId, (this.gatedVerified.get(groupId) ?? 0) + 1)
      }
      const k = this.quorumGroups?.get(groupId) ?? this.policy.k
      if ((this.gatedPassed.get(groupId) ?? 0) < k) return { kind: 'none' }
      // DP 义务守卫：verified 还不够 k，且组内剩余成员可能补上 verified
      if ((this.gatedVerified.get(groupId) ?? 0) < k) {
        const remaining = (this.groupMembers.get(groupId) ?? [])
          .filter(id => !this.settledIds.has(id))
        const evidenceStillPossible = remaining.some(id =>
          VERIFIED_CAPABLE_PROFILES.has(this.profiles.get(id) ?? ''))
        if (evidenceStillPossible) return { kind: 'none' }
      }
      this.firedGroups.add(groupId)
      return { kind: 'cancel_group', groupId }
    }

    // all_required / primary_decides / majority / weighted_confidence 不短路
    return { kind: 'none' }
  }

  /** 取消名单过滤：写工不取消（中途 abort 留半改文件）。 */
  cancellable(order: WorkOrder): boolean {
    return classifyProfile(order.profile) !== 'hands'
  }
}
