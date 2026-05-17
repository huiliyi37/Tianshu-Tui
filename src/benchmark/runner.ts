import { randomUUID } from 'node:crypto'
import { appendBenchmarkRun } from './store.js'
import type { BenchmarkRun } from './types.js'
import type { TaskSuite } from './task-suite.js'

export interface BenchmarkRunnerOptions {
  suite: TaskSuite
  suiteId: string
  provider: string
  model: string
  storeFile: string
  dryRun: boolean
}

export interface BenchmarkReport {
  runs: BenchmarkRun[]
}

/**
 * Run a benchmark suite. In dry-run mode, each task produces a blocked
 * record with zero metrics. In live mode (not yet implemented), tasks
 * are executed via the agent.
 */
export function runBenchmark(opts: BenchmarkRunnerOptions): BenchmarkReport {
  const runs: BenchmarkRun[] = []

  for (const task of opts.suite.tasks) {
    const run: BenchmarkRun = {
      runId: randomUUID(),
      suiteId: opts.suiteId,
      taskId: task.id,
      provider: opts.provider,
      model: opts.model,
      status: opts.dryRun ? 'blocked' : 'failed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      metrics: { turns: 0, toolCalls: 0, retries: 0 },
      failures: [],
    }

    appendBenchmarkRun(opts.storeFile, run)
    runs.push(run)
  }

  return { runs }
}
