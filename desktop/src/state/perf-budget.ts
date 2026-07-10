/**
 * Wave 0 — Performance budget instrumentation.
 *
 * A lightweight perf marks store + selector hook for the dev overlay.
 * Zero production overhead: every record path early-returns on
 * `import.meta.env.DEV` — Vite statically replaces it with `false` in prod
 * builds, so the branches (map ops, ring pushes, microtask scheduling) are
 * dead code and get dropped by the minifier.
 *
 * Usage in a hot path:
 *   const m = perfBegin('groupBlocks')
 *   ...work...
 *   perfEnd('groupBlocks', m)
 *
 * The store keeps a ring buffer of the last N samples per metric and
 * exposes p50/p99/max for the overlay.
 */

const IS_DEV: boolean = import.meta.env?.DEV ?? false

export interface PerfSample {
  at: number
  duration: number
}

export interface PerfMetric {
  samples: PerfSample[]
  p50: number
  p99: number
  max: number
  count: number
}

const RING_SIZE = 200
const metrics = new Map<string, PerfSample[]>()
const listeners = new Set<() => void>()
let dirty = false

// Throttled notification — coalesce writes within the same frame.
let flushScheduled = false
function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  // Use microtask so synchronous perfBegin/perfEnd pairs in the same tick
  // coalesce into one listener notification.
  queueMicrotask(() => {
    flushScheduled = false
    dirty = true
    for (const fn of listeners) fn()
  })
}

function percentile(sorted: number[], rank: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(rank * sorted.length))
  return sorted[idx]!
}

/** Begin a perf measurement. Returns an opaque handle for perfEnd. */
export function perfBegin(_name: string): number {
  if (!IS_DEV) return 0
  return performance.now()
}

/** End a perf measurement and record the duration. */
export function perfEnd(name: string, start: number): void {
  if (!IS_DEV) return
  const duration = performance.now() - start
  perfRecord(name, duration)
}

/** Record a pre-measured duration (e.g. from performance.measure). */
export function perfRecord(name: string, duration: number): void {
  if (!IS_DEV) return
  let ring = metrics.get(name)
  if (!ring) {
    ring = []
    metrics.set(name, ring)
  }
  ring.push({ at: performance.now(), duration })
  if (ring.length > RING_SIZE) ring.shift()
  scheduleFlush()
}

/** Subscribe to metric updates (for useSyncExternalStore). */
export function subscribePerf(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Get a snapshot of all metrics (p50/p99/max per name). Recomputes only when dirty. */
let cachedSnapshot: Readonly<Record<string, PerfMetric>> = {}
export function getPerfSnapshot(): Readonly<Record<string, PerfMetric>> {
  if (!dirty) return cachedSnapshot
  dirty = false
  const result: Record<string, PerfMetric> = {}
  for (const [name, samples] of metrics) {
    const durations = samples.map((s) => s.duration).sort((a, b) => a - b)
    result[name] = {
      samples: samples.slice(-20),
      p50: percentile(durations, 0.5),
      p99: percentile(durations, 0.99),
      max: durations[durations.length - 1] ?? 0,
      count: durations.length,
    }
  }
  cachedSnapshot = result
  return result
}

/** Reset all metrics (for testing or session switch). */
export function resetPerf(): void {
  metrics.clear()
  cachedSnapshot = {}
  dirty = true
  for (const fn of listeners) fn()
}

// ─── FPS tracking ─────────────────────────────────────────────

let fpsSamples: PerfSample[] = []
let rafId: number | null = null
let lastFrameTime = 0
let fpsActive = false

function fpsLoop(now: number): void {
  if (lastFrameTime > 0) {
    const delta = now - lastFrameTime
    // Only count frames < 200ms (ignore tab-switch gaps)
    if (delta < 200) {
      const fps = 1000 / delta
      fpsSamples.push({ at: now, duration: fps })
      if (fpsSamples.length > RING_SIZE) fpsSamples.shift()
    }
  }
  lastFrameTime = now
  if (fpsActive) {
    rafId = requestAnimationFrame(fpsLoop)
  }
}

/** Start FPS tracking. Safe to call multiple times (idempotent). */
export function startFpsTracking(): void {
  if (fpsActive) return
  fpsActive = true
  lastFrameTime = 0
  rafId = requestAnimationFrame(fpsLoop)
}

/** Stop FPS tracking. */
export function stopFpsTracking(): void {
  fpsActive = false
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

/** Get FPS metric (p50/p99 in fps units). */
export function getFpsMetric(): PerfMetric | null {
  if (fpsSamples.length === 0) return null
  const sorted = fpsSamples.map((s) => s.duration).sort((a, b) => a - b)
  return {
    samples: fpsSamples.slice(-20),
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    count: sorted.length,
  }
}

// ─── Long task tracking (scripting occupancy) ─────────────────
// Chromium-only (WebView2 / dev browser): the `longtask` entry type is not
// implemented in WKWebView. Feature-detected — silently absent on macOS.

let longTaskObserver: PerformanceObserver | null = null

/** Start observing long tasks (>50ms scripting blocks). Idempotent. */
export function startLongTaskTracking(): void {
  if (!IS_DEV || longTaskObserver) return
  if (typeof PerformanceObserver === 'undefined') return
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perfRecord('longtask', entry.duration)
    })
    obs.observe({ type: 'longtask', buffered: false })
    longTaskObserver = obs
  } catch {
    // Entry type unsupported (WKWebView) — heap/FPS still cover this platform.
  }
}

export function stopLongTaskTracking(): void {
  longTaskObserver?.disconnect()
  longTaskObserver = null
}

// ─── JS heap sampling ─────────────────────────────────────────
// performance.memory is Chromium-only (WebView2). On WKWebView the plan's
// fallback is manual sampling via Activity Monitor / Instruments.

interface ChromiumMemory {
  usedJSHeapSize: number
}

let heapTimer: ReturnType<typeof setInterval> | null = null

/** Sample used JS heap (MB) every 5s where the API exists. Idempotent. */
export function startHeapTracking(): void {
  if (!IS_DEV || heapTimer) return
  const probe = (performance as unknown as { memory?: ChromiumMemory }).memory
  if (!probe) return
  heapTimer = setInterval(() => {
    const mem = (performance as unknown as { memory?: ChromiumMemory }).memory
    if (mem) perfRecord('jsHeapMB', mem.usedJSHeapSize / (1024 * 1024))
  }, 5000)
}

export function stopHeapTracking(): void {
  if (heapTimer) {
    clearInterval(heapTimer)
    heapTimer = null
  }
}
