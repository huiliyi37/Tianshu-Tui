/**
 * Event-loop liveness signal (Phase 2 of the desktop reliability plan).
 *
 * The sidecar serves HTTP/SSE and runs the agent loop in ONE Node process, so
 * a long synchronous stretch (sync IO, big JSON.parse, inline diff fallback)
 * starves the SSE keepalive and /health at the same time — the client then
 * sees a "connection interrupted" it can't tell apart from a real network
 * drop. Publishing the measured loop delay on /health lets the UI (and the
 * Rust supervisor later) label that state honestly: "service busy", not
 * "disconnected".
 *
 * Windowed semantics: each snapshot() reports the delay distribution since the
 * previous snapshot and resets. With the desktop polling /health every 4s the
 * numbers describe the last poll window. Known limitation: while the loop is
 * fully blocked /health cannot answer at all — the spike shows up in the FIRST
 * response after the stall ends (maxMs), which is still enough to attribute
 * the preceding gap.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'

export interface LoopLagSnapshot {
  /** p99 event-loop delay in ms over the window since the last snapshot. */
  p99Ms: number
  /** Worst single delay in ms over the same window. */
  maxMs: number
}

const NS_PER_MS = 1e6

export class LoopHealthMonitor {
  // 20ms resolution keeps sampling overhead negligible (<0.1% CPU) while still
  // resolving the multi-hundred-ms stalls we care about.
  private hist = monitorEventLoopDelay({ resolution: 20 })
  private started = false

  start(): void {
    if (this.started) return
    this.hist.enable()
    this.started = true
  }

  stop(): void {
    if (!this.started) return
    this.hist.disable()
    this.started = false
  }

  /** Report the window since the previous snapshot, then reset the histogram. */
  snapshot(): LoopLagSnapshot {
    const p99 = this.hist.percentile(99) / NS_PER_MS
    const max = this.hist.max / NS_PER_MS
    this.hist.reset()
    return {
      p99Ms: Number.isFinite(p99) ? Math.round(p99 * 10) / 10 : 0,
      maxMs: Number.isFinite(max) ? Math.round(max * 10) / 10 : 0,
    }
  }
}
