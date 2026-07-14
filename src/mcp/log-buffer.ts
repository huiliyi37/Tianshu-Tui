// MCP log ring buffer — fixed-capacity in-memory log storage for stderr + transport events.
// Default 64 KB tail; configurable via RIVET_MCP_LOG_BYTES env var.

const DEFAULT_CAPACITY_BYTES = 64 * 1024

export interface LogEntry {
  ts: number
  stream: 'stderr' | 'event'
  text: string
}

export class LogRingBuffer {
  private entries: LogEntry[] = []
  private byteSize = 0
  private readonly capacityBytes: number

  constructor(capacityBytes: number = DEFAULT_CAPACITY_BYTES) {
    const env = Number.parseInt(process.env.RIVET_MCP_LOG_BYTES ?? '', 10)
    this.capacityBytes = Number.isFinite(env) && env > 0 ? env : capacityBytes
  }

  /** Append a log entry. Oldest entries are dropped when capacity is exceeded. */
  push(entry: LogEntry): void {
    const size = Buffer.byteLength(entry.text, 'utf8')
    this.entries.push(entry)
    this.byteSize += size
    while (this.byteSize > this.capacityBytes && this.entries.length > 0) {
      const removed = this.entries.shift()!
      this.byteSize -= Buffer.byteLength(removed.text, 'utf8')
    }
  }

  /** Get the most recent entries (up to `tail` count, newest last). */
  tail(count: number): LogEntry[] {
    return this.entries.slice(-count)
  }

  /** Get all entries. */
  all(): LogEntry[] {
    return [...this.entries]
  }

  /** Current total byte size. */
  get size(): number {
    return this.byteSize
  }

  /** Number of stored entries. */
  get count(): number {
    return this.entries.length
  }
}
