import type { WorkOrder } from './work-order.js'
import { classifyProfile } from './coordination-policy.js'
import type { AgentRole } from './coordination-policy.js'

export interface QueueEntry {
  order: WorkOrder
  priority: number
  /** 调度亲和键（星河收编 #4）：派生自 order.authority，dequeue 同 priority
   *  档内优先连续出队同域任务（同域 worker 共享预热/信息素/域课）。 */
  affinityKey?: string
}

export type QueueEvent =
  | { type: 'enqueued'; order: WorkOrder }
  | { type: 'dequeued'; order: WorkOrder }
  | { type: 'completed'; orderId: string }
  | { type: 'failed'; orderId: string }

export class WorkOrderQueue {
  private entries: QueueEntry[] = []
  private inFlightKeys = new Set<string>()
  private inFlightOrders = new Map<string, WorkOrder>()
  private completedIds = new Set<string>()
  private failedIds = new Set<string>()
  private maxConcurrency: number
  /** Separate concurrency cap for explore (read-only) workers. Default: same as maxConcurrency. */
  private maxExploreConcurrency: number
  /** Separate concurrency cap for hands (write) workers. Default: same as maxConcurrency. */
  private maxWriteConcurrency: number
  private listeners: Array<(event: QueueEvent) => void> = []
  /** 上一个出队 order 的 authority——亲和 tie-breaker 的锚点。 */
  private lastDequeuedAuthority: string | undefined

  constructor(maxConcurrency = Infinity, roleConcurrency?: { explore?: number; write?: number }) {
    this.maxConcurrency = maxConcurrency
    this.maxExploreConcurrency = roleConcurrency?.explore ?? maxConcurrency
    this.maxWriteConcurrency = roleConcurrency?.write ?? maxConcurrency
  }

  on(listener: (event: QueueEvent) => void): () => void {
    this.listeners.push(listener)
    return () => { this.listeners = this.listeners.filter(l => l !== listener) }
  }

  private emit(event: QueueEvent): void {
    for (const l of this.listeners) l(event)
  }

  enqueue(order: WorkOrder, priority = 0): boolean {
    if (this.inFlightKeys.has(order.dedupeKey)) return false
    if (this.entries.some(e => e.order.dedupeKey === order.dedupeKey)) return false
    this.entries.push({ order, priority, affinityKey: order.authority })
    this.entries.sort((a, b) => b.priority - a.priority)
    this.emit({ type: 'enqueued', order })
    return true
  }

  dequeue(): WorkOrder | undefined {
    // Per-role concurrency check: count in-flight workers by role
    let exploreInFlight = 0
    let writeInFlight = 0
    for (const [id, order] of this.inFlightOrders) {
      const role = classifyProfile(order.profile)
      if (role === 'hands') writeInFlight++
      else exploreInFlight++
    }

    // 条件依赖边（星河收编 #6）：主依赖完成 → 可运行；主依赖失败 →
    // skip 边不可运行（清扫标 skipped）、alternate 边等 alternate 完成。
    const depOk = (dep: string | import('./work-order.js').DependencyEdge): boolean => {
      if (typeof dep === 'string') return this.completedIds.has(dep)
      if (this.completedIds.has(dep.dependsOn)) return true
      if (this.failedIds.has(dep.dependsOn)) {
        if (dep.onFailure === 'alternate' && dep.alternateOrderId) {
          return this.completedIds.has(dep.alternateOrderId)
        }
        return false // skip / 无分支：依赖失败 → 不运行（清扫阶段标 blocked/skipped）
      }
      return false // 主依赖未完成
    }

    const canRun = (e: QueueEntry): boolean => {
      // 依赖检查
      if (!e.order.dependencies.every(depOk)) return false
      // 文件冲突检查
      if (this.hasFileConflict(e.order)) return false
      // Global concurrency cap: never exceed maxConcurrency regardless of role pools
      if (this.inFlightKeys.size >= this.maxConcurrency) return false
      // Per-role concurrency: explore workers limited by maxExploreConcurrency,
      // write workers limited by maxWriteConcurrency
      const role = classifyProfile(e.order.profile)
      if (role === 'hands') {
        if (writeInFlight >= this.maxWriteConcurrency) return false
      } else {
        if (exploreInFlight >= this.maxExploreConcurrency) return false
      }
      return true
    }

    const firstRunnable = this.entries.findIndex(canRun)
    if (firstRunnable === -1) return undefined
    // 亲和 tie-breaker（星河收编 #4）：只在同 priority 档内选与上一个出队
    // 同 authority 的任务——priority 优先不变，亲和不压依赖/冲突/并发检查
    // （那些 canRun 已一致）。
    let pick = firstRunnable
    if (this.lastDequeuedAuthority !== undefined) {
      const firstPriority = this.entries[firstRunnable]!.priority
      const affinity = this.entries.findIndex((e, i) =>
        i > firstRunnable && e.priority === firstPriority && e.affinityKey === this.lastDequeuedAuthority && canRun(e),
      )
      if (affinity !== -1) pick = affinity
    }

    const [entry] = this.entries.splice(pick, 1)
    if (!entry) return undefined
    this.lastDequeuedAuthority = entry.order.authority
    this.emit({ type: 'dequeued', order: entry.order })
    return entry.order
  }

  /** 检查 order 是否与 in-flight 任务有文件冲突 */
  hasFileConflict(order: WorkOrder): boolean {
    if (!order.scope.files?.length) return false
    // Two read-only workers can inspect the same snapshot in parallel. Keep
    // serialization whenever either side can write, so no worker reads a moving
    // target and concurrent writers remain exclusive.
    const orderWrites = classifyProfile(order.profile) === 'hands'
    const orderFiles = new Set(order.scope.files)
    for (const inflight of this.inFlightOrders.values()) {
      if (!inflight.scope.files?.length) continue
      const inflightWrites = classifyProfile(inflight.profile) === 'hands'
      if (!orderWrites && !inflightWrites) continue
      if (inflight.scope.files.some(f => orderFiles.has(f))) return true
    }
    return false
  }

  markInFlight(order: WorkOrder): void {
    this.inFlightKeys.add(order.dedupeKey)
    this.inFlightOrders.set(order.id, order)
  }

  markCompleted(order: { id: string; dedupeKey?: string }): void {
    this.completedIds.add(order.id)
    if (order.dedupeKey) this.inFlightKeys.delete(order.dedupeKey)
    this.inFlightOrders.delete(order.id)
    this.emit({ type: 'completed', orderId: order.id })
  }

  markFailed(order: WorkOrder): void {
    this.inFlightKeys.delete(order.dedupeKey)
    this.inFlightOrders.delete(order.id)
    // Record the failure so dependents can be distinguished as "dependency failed"
    // (vs. "dependency never scheduled") during the post-drain blocked sweep.
    // A failed id is NOT added to completedIds: dependents must NOT run on a
    // broken foundation — they are settled as `blocked`, never silently dropped.
    this.failedIds.add(order.id)
    this.emit({ type: 'failed', orderId: order.id })
  }

  /** True once an order has completed successfully (its dependents may run). */
  isCompleted(id: string): boolean {
    return this.completedIds.has(id)
  }

  /** True once an order has failed (its dependents must be blocked, not run). */
  hasFailed(id: string): boolean {
    return this.failedIds.has(id)
  }

  size(): number {
    return this.entries.length
  }

  inFlightCount(): number {
    return this.inFlightKeys.size
  }

  pending(): WorkOrder[] {
    return this.entries.map(e => e.order)
  }

  /** In-flight order 快照（策略短路挑同组在跑成员用）。 */
  inFlight(): WorkOrder[] {
    return [...this.inFlightOrders.values()]
  }

  /** 撤走满足谓词且尚未调度的 order。被撤 order 记入 failedIds
   *  （="不再产出"，依赖者走既有 skip/alternate/blocked 语义），
   *  返回被撤列表供调用方合成 policy-cancelled 结果。 */
  cancelPending(predicate: (order: WorkOrder) => boolean): WorkOrder[] {
    const cancelled: WorkOrder[] = []
    this.entries = this.entries.filter(e => {
      if (!predicate(e.order)) return true
      cancelled.push(e.order)
      return false
    })
    for (const order of cancelled) {
      this.failedIds.add(order.id)
      this.emit({ type: 'failed', orderId: order.id })
    }
    return cancelled
  }
}
