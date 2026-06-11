/**
 * In-flight worker stall detection (T10 A4 — 运行态主闸).
 *
 * Tracks last-activity time per in-flight worker so the coordinator can
 * detect a worker that stopped producing tokens BEFORE its budget/hardStall
 * fires — turning a 180s frozen session into an early, observable abort.
 *
 * Design principle: workers die for **silence**, never for duration. The
 * wall-clock budget stays a far backstop; this is the primary runtime gate.
 */

/** Default silence tolerance for read-only (explore) workers. */
export const EXPLORE_STALL_MS = 90_000
/** Default silence tolerance for write (hands) workers — edits pause longer. */
export const WRITE_STALL_MS = 120_000

export interface WorkerLivenessOptions {
  /** No activity for this long ⇒ worker is considered stalled. */
  stallMs: number
  /** Injectable clock for tests. */
  now?: () => number
}

export class WorkerLiveness {
  private readonly defaultStallMs: number
  private readonly now: () => number
  private readonly lastActivity = new Map<string, number>()
  private readonly stallMsById = new Map<string, number>()

  constructor(opts: WorkerLivenessOptions) {
    this.defaultStallMs = opts.stallMs
    this.now = opts.now ?? Date.now
  }

  /** Start tracking a worker. Optional per-worker silence tolerance. */
  register(id: string, stallMs?: number): void {
    this.lastActivity.set(id, this.now())
    if (stallMs !== undefined) this.stallMsById.set(id, stallMs)
  }

  /** Record activity — resets the worker's stall clock. */
  tick(id: string): void {
    if (this.lastActivity.has(id)) this.lastActivity.set(id, this.now())
  }

  /** Stop tracking (worker completed/failed) — no false stall afterwards. */
  unregister(id: string): void {
    this.lastActivity.delete(id)
    this.stallMsById.delete(id)
  }

  /** Ids whose silence exceeds their stall tolerance. */
  stalled(): string[] {
    const t = this.now()
    const out: string[] = []
    for (const [id, last] of this.lastActivity) {
      const tolerance = this.stallMsById.get(id) ?? this.defaultStallMs
      if (t - last > tolerance) out.push(id)
    }
    return out
  }

  /** Number of workers currently tracked. */
  size(): number {
    return this.lastActivity.size
  }
}
