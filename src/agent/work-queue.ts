import type { WorkOrder } from './work-order.js'

export interface QueueEntry {
  order: WorkOrder
  priority: number
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
  private maxConcurrency: number
  private listeners: Array<(event: QueueEvent) => void> = []

  constructor(maxConcurrency = Infinity) {
    this.maxConcurrency = maxConcurrency
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
    this.entries.push({ order, priority })
    this.entries.sort((a, b) => b.priority - a.priority)
    this.emit({ type: 'enqueued', order })
    return true
  }

  dequeue(): WorkOrder | undefined {
    if (this.inFlightKeys.size >= this.maxConcurrency) return undefined

    const index = this.entries.findIndex(e => {
      // 依赖检查
      if (!e.order.dependencies.every(dep => this.completedIds.has(dep))) return false
      // 文件冲突检查
      if (this.hasFileConflict(e.order)) return false
      return true
    })

    if (index === -1) return undefined
    const [entry] = this.entries.splice(index, 1)
    if (!entry) return undefined
    this.emit({ type: 'dequeued', order: entry.order })
    return entry.order
  }

  /** 检查 order 是否与 in-flight 任务有文件冲突 */
  hasFileConflict(order: WorkOrder): boolean {
    if (!order.scope.files?.length) return false
    const orderFiles = new Set(order.scope.files)
    for (const inflight of this.inFlightOrders.values()) {
      if (!inflight.scope.files?.length) continue
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
    this.emit({ type: 'failed', orderId: order.id })
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
}
