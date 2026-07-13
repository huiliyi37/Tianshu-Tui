import { monitorEventLoopDelay } from 'node:perf_hooks'

export type TuiPerfSample = 'renderLive' | 'delta' | 'formatMarkdown' | 'flush'

export interface PerfStats {
  count: number
  p50Ms: number
  p99Ms: number
  maxMs: number
}

export interface LoopLagStats {
  p99Ms: number
  maxMs: number
}

export interface EventLoopHistogram {
  readonly max: number
  enable(): void
  disable(): void
  reset(): void
  percentile(percentile: number): number
}

export interface TuiPerfSummary {
  kind: 'perf-summary'
  samples: Record<TuiPerfSample, PerfStats>
  cache: { hits: number; misses: number }
  loopLag: LoopLagStats
}

interface TuiPerfMonitorOptions {
  enabled: boolean
  now?: () => number
  createHistogram?: () => EventLoopHistogram
}

const SAMPLE_NAMES: readonly TuiPerfSample[] = ['renderLive', 'delta', 'formatMarkdown', 'flush']
const NS_PER_MS = 1e6
const MAX_RETAINED_SAMPLES = 4096

function roundMs(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

function emptyStats(): PerfStats {
  return { count: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 }
}

export function isTuiPerfEnabled(
  args: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return args.includes('--debug-perf') || env.RIVET_DEBUG_TELEMETRY === '1'
}

export class TuiPerfMonitor {
  readonly enabled: boolean
  private readonly now: () => number
  private readonly histogram?: EventLoopHistogram
  private readonly samples?: Record<TuiPerfSample, number[]>
  private readonly counts?: Record<TuiPerfSample, number>
  private readonly maxima?: Record<TuiPerfSample, number>
  private cacheHits = 0
  private cacheMisses = 0
  private lastLoopLag: LoopLagStats = { p99Ms: 0, maxMs: 0 }
  private lastLoopLagAt = Number.NEGATIVE_INFINITY
  private stopped = false

  constructor(options: TuiPerfMonitorOptions) {
    this.enabled = options.enabled
    this.now = options.now ?? (() => performance.now())
    if (!this.enabled) return

    this.samples = {
      renderLive: [],
      delta: [],
      formatMarkdown: [],
      flush: [],
    }
    this.counts = { renderLive: 0, delta: 0, formatMarkdown: 0, flush: 0 }
    this.maxima = { renderLive: 0, delta: 0, formatMarkdown: 0, flush: 0 }
    this.histogram = (options.createHistogram ?? (() => monitorEventLoopDelay({ resolution: 20 })))()
    this.histogram.enable()
  }

  measure<T>(name: TuiPerfSample, operation: () => T): T {
    if (!this.enabled) return operation()
    const start = this.now()
    try {
      return operation()
    } finally {
      this.record(name, this.now() - start)
    }
  }

  record(name: TuiPerfSample, durationMs: number): void {
    if (!this.enabled || !this.samples || !this.counts || !this.maxima) return
    const value = Math.max(0, durationMs)
    const retained = this.samples[name]
    if (retained.length >= MAX_RETAINED_SAMPLES) retained.shift()
    retained.push(value)
    this.counts[name]++
    this.maxima[name] = Math.max(this.maxima[name], value)
  }

  recordCache(hit: boolean): void {
    if (!this.enabled) return
    if (hit) this.cacheHits++
    else this.cacheMisses++
  }

  getLoopLagWindow(minIntervalMs = 1000): LoopLagStats {
    if (!this.enabled || !this.histogram) return this.lastLoopLag
    const now = this.now()
    if (now - this.lastLoopLagAt < minIntervalMs) return this.lastLoopLag
    this.lastLoopLag = this.sampleLoopLag()
    this.lastLoopLagAt = now
    return this.lastLoopLag
  }

  summary(): TuiPerfSummary | undefined {
    if (!this.enabled || !this.samples || !this.counts || !this.maxima) return undefined
    const stats = {} as Record<TuiPerfSample, PerfStats>
    for (const name of SAMPLE_NAMES) {
      const retained = [...this.samples[name]].sort((a, b) => a - b)
      if (retained.length === 0) {
        stats[name] = emptyStats()
        continue
      }
      const percentile = (p: number) => retained[Math.max(0, Math.ceil(p * retained.length) - 1)]!
      stats[name] = {
        count: this.counts[name],
        p50Ms: roundMs(percentile(0.5)),
        p99Ms: roundMs(percentile(0.99)),
        maxMs: roundMs(this.maxima[name]),
      }
    }
    return {
      kind: 'perf-summary',
      samples: stats,
      cache: { hits: this.cacheHits, misses: this.cacheMisses },
      loopLag: this.sampleLoopLag(),
    }
  }

  stop(): void {
    if (!this.histogram || this.stopped) return
    this.histogram.disable()
    this.stopped = true
  }

  private sampleLoopLag(): LoopLagStats {
    if (!this.histogram) return this.lastLoopLag
    const snapshot = {
      p99Ms: roundMs(this.histogram.percentile(99) / NS_PER_MS),
      maxMs: roundMs(this.histogram.max / NS_PER_MS),
    }
    this.histogram.reset()
    return snapshot
  }
}
