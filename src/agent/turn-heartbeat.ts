/**
 * Turn-level heartbeat watchdog.
 *
 * Problem (P7): During long operations — large tool results, slow LLM streams,
 * compaction, multi-tool batches — the UI receives no events for tens of
 * seconds. Users cannot tell whether the agent is working or stuck, and
 * frequently interrupt to ask "what's happening?". The interruption itself
 * disrupts the agent's context.
 *
 * Solution: a heartbeat that fires only during silent periods. Every event
 * the agent emits (text delta, tool result, phase change) calls `tick()` to
 * reset the silence clock. If `silentMs` elapses without a tick, the
 * heartbeat fires `onHeartbeat(elapsedMs, lastActivity)` so the UI can show
 * "still working — waiting on <last-activity> for N seconds" instead of a
 * frozen spinner.
 *
 * The heartbeat is purely informational — it does NOT abort or modify
 * agent state. Idle timeouts on tools and SSE handle real hangs.
 */
export interface TurnHeartbeatOptions {
  /** Milliseconds of silence before firing the first heartbeat. Default 15s. */
  silentMs?: number
  /** Subsequent heartbeat interval after the first fires. Default 10s. */
  repeatMs?: number
  /** Called when silence threshold is crossed. */
  onHeartbeat: (elapsedMs: number, lastActivity: string) => void
}

export class TurnHeartbeat {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastTick = Date.now()
  private lastActivity = 'starting'
  private firstFired = false
  private stopped = false
  private readonly silentMs: number
  private readonly repeatMs: number
  private readonly onHeartbeat: TurnHeartbeatOptions['onHeartbeat']

  constructor(opts: TurnHeartbeatOptions) {
    this.silentMs = opts.silentMs ?? 15_000
    this.repeatMs = opts.repeatMs ?? 10_000
    this.onHeartbeat = opts.onHeartbeat
  }

  /** Start watching. Call once per turn. */
  start(): void {
    this.stopped = false
    this.lastTick = Date.now()
    this.firstFired = false
    this.scheduleNext(this.silentMs)
  }

  /** Reset the silence clock. Call on every UI-visible event. */
  tick(activity: string): void {
    if (this.stopped) return
    this.lastTick = Date.now()
    this.lastActivity = activity
    this.firstFired = false
    this.scheduleNext(this.silentMs)
  }

  /** Stop firing. Call when the turn ends (success, abort, or error). */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.fire(), delayMs)
  }

  private fire(): void {
    if (this.stopped) return
    const elapsed = Date.now() - this.lastTick
    // Guard: if a tick happened during scheduling drift, skip and reschedule.
    if (elapsed < this.silentMs - 500) {
      this.scheduleNext(this.silentMs - elapsed)
      return
    }
    try {
      this.onHeartbeat(elapsed, this.lastActivity)
    } catch {
      // Heartbeat callback errors must not break the agent.
    }
    this.firstFired = true
    this.scheduleNext(this.repeatMs)
  }

  /** Test-only: query whether the first heartbeat has fired since last tick. */
  hasFiredSinceTick(): boolean {
    return this.firstFired
  }
}
