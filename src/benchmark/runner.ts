import { randomUUID } from 'node:crypto'
import { appendBenchmarkRun } from './store.js'
import type { BenchmarkMetrics, BenchmarkRun } from './types.js'
import type { TaskSuite } from './task-suite.js'
import type { BenchmarkExecutor } from './executor.js'

export interface BenchmarkRunnerOptions {
  suite: TaskSuite
  suiteId: string
  provider: string
  model: string
  storeFile: string
  dryRun: boolean
  executor?: BenchmarkExecutor
}

export interface BenchmarkReport {
  runs: BenchmarkRun[]
}

/**
 * Run a benchmark suite. Live mode requires an executor so benchmarks cannot
 * silently claim results without actually invoking an agent.
 */
export async function runBenchmark(opts: BenchmarkRunnerOptions): Promise<BenchmarkReport> {
  if (!opts.dryRun && !opts.executor) {
    throw new Error('Live benchmarks require a BenchmarkExecutor.')
  }

  const runs: BenchmarkRun[] = []

  for (const task of opts.suite.tasks) {
    const startedAt = new Date().toISOString()
    let status: BenchmarkRun['status'] = 'blocked'
    let metrics: BenchmarkMetrics = { turns: 0, toolCalls: 0, retries: 0 }
    let failures: BenchmarkRun['failures'] = []

    if (!opts.dryRun) {
      try {
        const execution = await opts.executor!.execute(task)
        status = execution.status
        metrics = {
          turns: execution.metrics?.turns ?? 0,
          toolCalls: execution.metrics?.toolCalls ?? 0,
          retries: execution.metrics?.retries ?? 0,
          ...(execution.metrics?.cacheHitRate !== undefined ? { cacheHitRate: execution.metrics.cacheHitRate } : {}),
          ...(execution.metrics?.costUsd !== undefined ? { costUsd: execution.metrics.costUsd } : {}),
        }
        failures = execution.failures ?? []
      } catch (error) {
        status = 'failed'
        failures = [{
          class: 'executor_error',
          message: error instanceof Error ? error.message : String(error),
        }]
      }
    }

    const run: BenchmarkRun = {
      runId: randomUUID(),
      suiteId: opts.suiteId,
      taskId: task.id,
      provider: opts.provider,
      model: opts.model,
      status,
      startedAt,
      endedAt: new Date().toISOString(),
      metrics,
      failures,
    }

    appendBenchmarkRun(opts.storeFile, run)
    runs.push(run)
  }

  return { runs }
}
