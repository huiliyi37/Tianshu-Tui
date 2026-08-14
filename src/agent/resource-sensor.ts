import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getHeapStatistics } from 'node:v8'

export interface MemorySample {
  timestamp: number
  rssBytes: number
  heapUsedBytes: number
  memoryLimitBytes: number
}

export interface DiskSample {
  timestamp: number
  sessionBytes: number
  sessionByteLimit: number
  path: string
}

export interface ResourceSensorSnapshot {
  memory: MemorySample
  disk?: DiskSample
  memoryTrendBytesPerSample: number
  /** True while absolute heap pressure should not escalate reliability to minimal. */
  memoryCooldownActive: boolean
}

export interface ResourceSensorOptions {
  memoryLimitBytes?: number
  sessionByteLimit?: number
  now?: () => number
  memoryUsage?: () => Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed'>
  /**
   * After construction / reset(), suppress memory-pressure signals for this many
   * samples: absolute heap warn/error stays muted, and cooldown samples are kept
   * out of the RSS trend window so the startup ramp is not read as a leak.
   * Desktop sidecar heap is process-shared across sessions — a fresh agent must
   * not inherit the previous session's pressure lockout. Default 3.
   */
  initialMemoryCooldownSamples?: number
}

const DEFAULT_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024
export const DEFAULT_SESSION_BYTE_LIMIT = 50 * 1024 * 1024
const MAX_MEMORY_SAMPLES = 12
export const DEFAULT_MEMORY_COOLDOWN_SAMPLES = 3

function defaultMemoryLimitBytes(): number {
  const configured = Number(process.env.RIVET_MEMORY_LIMIT_BYTES)
  if (Number.isFinite(configured) && configured > 0) return configured
  // Read the actual V8 old-space ceiling so heapRatio/rssRatio track the real
  // crash point. On the desktop the sidecar is spawned as `node main.js` (the
  // tsup shebang's --max-old-space-size is ignored, entirely so on Windows), so
  // this reflects whatever ceiling the launcher passed — the hardcoded 1GB below
  // otherwise decouples every memory-pressure signal from reality.
  try {
    const limit = getHeapStatistics().heap_size_limit
    if (Number.isFinite(limit) && limit > 0) return limit
  } catch {
    // getHeapStatistics unavailable — fall back to the conservative constant.
  }
  return DEFAULT_MEMORY_LIMIT_BYTES
}

function linearRegressionSlope(values: number[]): number {
  const n = values.length
  if (n < 2) return 0

  const meanX = (n - 1) / 2
  const meanY = values.reduce((sum, value) => sum + value, 0) / n
  let numerator = 0
  let denominator = 0
  for (let x = 0; x < n; x++) {
    numerator += (x - meanX) * (values[x]! - meanY)
    denominator += (x - meanX) ** 2
  }
  return denominator === 0 ? 0 : numerator / denominator
}

/** Sum the primary session file plus sibling claims / events when present. */
function measureSessionRelatedBytes(path: string): number {
  let total = 0
  try {
    total += statSync(path).size
  } catch {
    return 0
  }

  // CLI layout: <id>.jsonl + <id>.claims.jsonl + optional <id>/events.jsonl
  if (path.endsWith('.jsonl') && !path.endsWith('events.jsonl')) {
    const claims = path.replace(/\.jsonl$/, '.claims.jsonl')
    try { total += statSync(claims).size } catch { /* optional */ }
    const sessionDir = path.replace(/\.jsonl$/, '')
    const eventsInSessionDir = join(sessionDir, 'events.jsonl')
    try { total += statSync(eventsInSessionDir).size } catch { /* optional */ }
  }

  // Desktop layout: directory with events.jsonl (+ maybe other jsonl)
  try {
    const st = statSync(path)
    if (st.isDirectory()) {
      for (const name of readdirSync(path)) {
        if (!name.endsWith('.jsonl') && name !== 'index.json') continue
        try { total += statSync(join(path, name)).size } catch { /* skip */ }
      }
    } else {
      // Also peek at sibling dir named like the jsonl stem
      const parent = dirname(path)
      if (existsSync(parent) && path.endsWith('.jsonl')) {
        const stem = path.slice(0, -'.jsonl'.length)
        // already counted claims / sessionDir above
        void stem
      }
    }
  } catch { /* ignore */ }

  return total
}

export class ResourceSensor {
  private memorySamples: MemorySample[] = []
  private memoryCooldownRemaining: number
  private readonly memoryCooldownSamples: number
  private readonly now: () => number
  private readonly memoryUsage: () => Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed'>
  private readonly memoryLimitBytes: number
  private readonly sessionByteLimit: number

  constructor(options: ResourceSensorOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
    this.memoryLimitBytes = options.memoryLimitBytes ?? defaultMemoryLimitBytes()
    this.sessionByteLimit = options.sessionByteLimit ?? DEFAULT_SESSION_BYTE_LIMIT
    this.memoryCooldownSamples = options.initialMemoryCooldownSamples ?? DEFAULT_MEMORY_COOLDOWN_SAMPLES
    this.memoryCooldownRemaining = this.memoryCooldownSamples
  }

  /**
   * Clear trend history and re-arm absolute-heap cooldown. Call on session /
   * agent rebuild boundaries in the long-lived desktop sidecar.
   */
  reset(cooldownSamples?: number): void {
    this.memorySamples = []
    this.memoryCooldownRemaining = cooldownSamples ?? this.memoryCooldownSamples
  }

  isMemoryCooldownActive(): boolean {
    return this.memoryCooldownRemaining > 0
  }

  sample(sessionPath?: string): ResourceSensorSnapshot {
    const memory = this.sampleMemory()
    return {
      memory,
      disk: sessionPath ? this.sampleDisk(sessionPath) : undefined,
      memoryTrendBytesPerSample: this.memoryTrendBytesPerSample(),
      memoryCooldownActive: this.isMemoryCooldownActive(),
    }
  }

  sampleMemory(): MemorySample {
    const usage = this.memoryUsage()
    const sample: MemorySample = {
      timestamp: this.now(),
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      memoryLimitBytes: this.memoryLimitBytes,
    }
    if (this.memoryCooldownRemaining > 0) {
      // Startup ramp (module load, first prompt assembly) inflates RSS for the
      // first few samples — keeping them out of the trend window stops the
      // regression slope from reporting the cold start as a memory leak.
      this.memoryCooldownRemaining -= 1
    } else {
      this.memorySamples = [...this.memorySamples, sample].slice(-MAX_MEMORY_SAMPLES)
    }
    return sample
  }

  sampleDisk(path: string): DiskSample {
    const sessionBytes = measureSessionRelatedBytes(path)
    return {
      timestamp: this.now(),
      sessionBytes,
      sessionByteLimit: this.sessionByteLimit,
      path,
    }
  }

  memoryTrendBytesPerSample(): number {
    return linearRegressionSlope(this.memorySamples.map(sample => sample.rssBytes))
  }
}
