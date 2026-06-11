/**
 * Steer Buffer — accumulates user guidance messages during agent execution.
 * Messages are injected at the next tool result or turn boundary,
 * not as direct interruptions.
 */

export class SteerBuffer {
  private pending: string[] = []
  private listeners: Array<() => void> = []

  /** Add a user guidance message to the buffer */
  push(message: string): void {
    this.pending.push(message)
    this.notify()
  }

  /** Check if there are pending messages */
  hasPending(): boolean {
    return this.pending.length > 0
  }

  /** Get pending messages for display */
  getPending(): readonly string[] {
    return this.pending
  }

  /** Drain all pending messages and format them for injection */
  drain(): string | null {
    if (this.pending.length === 0) return null
    const messages = this.pending
    this.pending = []
    this.notify()
    return messages.length === 1
      ? `[User guidance]: ${messages[0]}`
      : `[User guidance]:\n${messages.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
  }

  /** 取回最近一条排队消息（Up 箭头取回编辑用） */
  popLast(): string | null {
    if (this.pending.length === 0) return null
    const last = this.pending.pop()!
    this.notify()
    return last
  }

  /** Clear all pending messages */
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

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
