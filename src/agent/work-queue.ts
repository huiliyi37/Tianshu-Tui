import type { WorkOrder } from './work-order.js'

export interface QueueEntry {
  order: WorkOrder
  priority: number
}

export class WorkOrderQueue {
  private entries: QueueEntry[] = []
  private inFlightKeys = new Set<string>()
  private completedIds = new Set<string>()
  private maxConcurrency: number

  constructor(maxConcurrency = Infinity) {
    this.maxConcurrency = maxConcurrency
  }

  enqueue(order: WorkOrder, priority = 0): boolean {
    if (this.inFlightKeys.has(order.dedupeKey)) return false
    if (this.entries.some(e => e.order.dedupeKey === order.dedupeKey)) return false
    this.entries.push({ order, priority })
    this.entries.sort((a, b) => b.priority - a.priority)
    return true
  }

  dequeue(): WorkOrder | undefined {
    if (this.inFlightKeys.size >= this.maxConcurrency) return undefined

    const index = this.entries.findIndex(e =>
      e.order.dependencies.every(dep => this.completedIds.has(dep)),
    )

    if (index === -1) return undefined
    const [entry] = this.entries.splice(index, 1)
    if (!entry) return undefined
    return entry.order
  }

  markInFlight(order: WorkOrder): void {
    this.inFlightKeys.add(order.dedupeKey)
  }

  markCompleted(order: { id: string; dedupeKey?: string }): void {
    this.completedIds.add(order.id)
    if (order.dedupeKey) this.inFlightKeys.delete(order.dedupeKey)
  }

  markFailed(order: WorkOrder): void {
    this.inFlightKeys.delete(order.dedupeKey)
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
