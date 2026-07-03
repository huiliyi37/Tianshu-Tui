import { statSync } from 'node:fs'
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
}

export interface ResourceSensorOptions {
  memoryLimitBytes?: number
  sessionByteLimit?: number
  now?: () => number
  memoryUsage?: () => Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed'>
}

const DEFAULT_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024
export const DEFAULT_SESSION_BYTE_LIMIT = 50 * 1024 * 1024
const MAX_MEMORY_SAMPLES = 12

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

export class ResourceSensor {
  private memorySamples: MemorySample[] = []
  private readonly now: () => number
  private readonly memoryUsage: () => Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed'>
  private readonly memoryLimitBytes: number
  private readonly sessionByteLimit: number

  constructor(options: ResourceSensorOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
    this.memoryLimitBytes = options.memoryLimitBytes ?? defaultMemoryLimitBytes()
    this.sessionByteLimit = options.sessionByteLimit ?? DEFAULT_SESSION_BYTE_LIMIT
  }

  sample(sessionPath?: string): ResourceSensorSnapshot {
    const memory = this.sampleMemory()
    return {
      memory,
      disk: sessionPath ? this.sampleDisk(sessionPath) : undefined,
      memoryTrendBytesPerSample: this.memoryTrendBytesPerSample(),
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
    this.memorySamples = [...this.memorySamples, sample].slice(-MAX_MEMORY_SAMPLES)
    return sample
  }

  sampleDisk(path: string): DiskSample {
    let sessionBytes = 0
    try {
      sessionBytes = statSync(path).size
    } catch {
      sessionBytes = 0
    }
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
