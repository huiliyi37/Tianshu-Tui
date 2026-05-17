import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { benchmarkRunSchema } from './types.js'
import type { BenchmarkRun } from './types.js'

/**
 * Append a benchmark run record as a JSONL line. Creates parent directories
 * if they don't exist.
 */
export function appendBenchmarkRun(file: string, run: BenchmarkRun): void {
  const dir = dirname(file)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const parsed = benchmarkRunSchema.parse(run)
  appendFileSync(file, JSON.stringify(parsed) + '\n', 'utf-8')
}

export interface ReadOptions {
  suiteId?: string
  taskId?: string
}

/**
 * Read all benchmark runs from a JSONL file, optionally filtered by
 * suiteId and/or taskId. Returns empty array for missing files.
 * Invalid lines are silently skipped.
 */
export function readBenchmarkRuns(
  file: string,
  opts?: ReadOptions,
): BenchmarkRun[] {
  if (!existsSync(file)) return []

  const content = readFileSync(file, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  const runs: BenchmarkRun[] = []

  for (const line of lines) {
    try {
      const parsed = benchmarkRunSchema.parse(JSON.parse(line))
      if (opts?.suiteId && parsed.suiteId !== opts.suiteId) continue
      if (opts?.taskId && parsed.taskId !== opts.taskId) continue
      runs.push(parsed)
    } catch {
      // skip invalid lines
    }
  }

  return runs
}
