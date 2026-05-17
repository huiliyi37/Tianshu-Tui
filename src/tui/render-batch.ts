/**
 * Batches rapid-fire callback invocations into single microtask-aligned updates.
 */

export type FlushFn<T> = (items: T[]) => void

export class RenderBatcher<T> {
  private queue: T[] = []
  private scheduled = false

  constructor(private flush: FlushFn<T>) {}

  push(item: T): void {
    this.queue.push(item)
    if (!this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => {
        this.scheduled = false
        const items = this.queue
        this.queue = []
        if (items.length > 0) {
          this.flush(items)
        }
      })
    }
  }

  /** Flush any pending items synchronously (before turn end) */
  flushNow(): void {
    const items = this.queue
    this.queue = []
    this.scheduled = false
    if (items.length > 0) {
      this.flush(items)
    }
  }

  get pending(): number {
    return this.queue.length
  }
}
