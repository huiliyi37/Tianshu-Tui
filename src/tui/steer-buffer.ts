/**
 * Steer Buffer — accumulates user guidance messages and commands during agent
 * execution, then drains them at the next tool result or turn boundary.
 *
 * Upgraded from a plain string FIFO to a priority queue:
 *   now  > next > later
 * Within the same priority, items stay FIFO. This prevents task notifications
 * from starving user steer messages and keeps urgent slash commands ahead of
 * background guidance.
 */

export type SteerPriority = 'now' | 'next' | 'later'

export interface SteerEntry {
  /** Queue-unique id */
  id: number
  /** Raw text payload */
  text: string
  /** Drain priority */
  priority: SteerPriority
}

const PRIORITY_ORDER: Record<SteerPriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

export class SteerBuffer {
  private pending: SteerEntry[] = []
  private listeners: Array<() => void> = []
  private nextId = 1

  /** Add a user guidance message to the buffer (default priority: later). */
  push(message: string, priority: SteerPriority = 'later'): void {
    this.pending.push({ id: this.nextId++, text: message, priority })
    this.notify()
  }

  /** Add an urgent command that should be processed before normal guidance. */
  pushNow(message: string): void {
    this.push(message, 'now')
  }

  /** Add a high-priority message, processed after `now` but before `later`. */
  pushNext(message: string): void {
    this.push(message, 'next')
  }

  /** Check if there are pending messages. Optional `maxPriority` restricts the check. */
  hasPending(maxPriority?: SteerPriority): boolean {
    if (this.pending.length === 0) return false
    if (maxPriority === undefined) return true
    const threshold = PRIORITY_ORDER[maxPriority]
    return this.pending.some(entry => PRIORITY_ORDER[entry.priority] <= threshold)
  }

  /** Get pending message texts in insertion order (backward compatible). */
  getPending(): readonly string[] {
    return this.pending.map(entry => entry.text)
  }

  /** Get pending entries in drain order (priority then insertion order). */
  getPendingEntries(): readonly SteerEntry[] {
    return this.sorted()
  }

  /**
   * Drain pending messages and format them for injection.
   * If `maxPriority` is given, only messages at or above that priority are
   * drained; the rest remain queued.
   */
  drain(maxPriority?: SteerPriority): string | null {
    if (this.pending.length === 0) return null

    const threshold = maxPriority === undefined ? Infinity : PRIORITY_ORDER[maxPriority]
    const drainable = this.pending.filter(entry => PRIORITY_ORDER[entry.priority] <= threshold)
    if (drainable.length === 0) return null

    this.pending = this.pending.filter(entry => PRIORITY_ORDER[entry.priority] > threshold)
    this.notify()

    const messages = drainable.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority]
      const pb = PRIORITY_ORDER[b.priority]
      if (pa !== pb) return pa - pb
      return a.id - b.id
    }).map(entry => entry.text)

    return messages.length === 1
      ? `[User guidance]: ${messages[0]}`
      : `[User guidance]:\n${messages.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
  }

  /** Peek at the highest-priority pending text without removing it. */
  peek(maxPriority?: SteerPriority): string | null {
    const entries = this.sorted()
    if (entries.length === 0) return null
    if (maxPriority === undefined) return entries[0]!.text
    const threshold = PRIORITY_ORDER[maxPriority]
    const entry = entries.find(e => PRIORITY_ORDER[e.priority] <= threshold)
    return entry?.text ?? null
  }

  /** Take back the most recently queued message (Up-arrow recall). */
  popLast(): string | null {
    if (this.pending.length === 0) return null
    const last = this.pending.pop()!
    this.notify()
    return last.text
  }

  /** Clear all pending messages. */
  clear(): void {
    if (this.pending.length === 0) return
    this.pending = []
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private sorted(): SteerEntry[] {
    return [...this.pending].sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority]
      const pb = PRIORITY_ORDER[b.priority]
      if (pa !== pb) return pa - pb
      return a.id - b.id
    })
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
