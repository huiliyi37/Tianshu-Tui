import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBenchmark } from '../runner.js'
import type { TaskSuite } from '../task-suite.js'

describe('runBenchmark (dry-run)', () => {
  let dir: string
  let storeFile: string

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'rivet-runner-'))
    storeFile = join(dir, 'runs.jsonl')
  }

  function teardown() {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }

  const suite: TaskSuite = {
    tasks: [
      {
        id: 'task-1',
        title: 'Read a file',
        category: 'repo_inspection',
        prompt: 'Read README.md',
        setupCommands: [],
        successCommands: [],
        timeoutMs: 30000,
        tags: [],
      },
      {
        id: 'task-2',
        title: 'Fix a bug',
        category: 'test_repair',
        prompt: 'Fix the failing test',
        setupCommands: ['npm install'],
        successCommands: [],
        timeoutMs: 60000,
        tags: [],
      },
    ],
  }

  it('produces blocked records for all tasks in dry-run mode', async () => {
    setup()
    try {
      const report = await runBenchmark({
        suite,
        suiteId: 'r1-local-coding-smoke',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        storeFile,
        dryRun: true,
      })

      assert.equal(report.runs.length, 2)
      assert.ok(report.runs.every(r => r.status === 'blocked'))
      assert.equal(report.runs[0]!.taskId, 'task-1')
      assert.equal(report.runs[1]!.taskId, 'task-2')
      assert.equal(report.runs[0]!.metrics.turns, 0)
      assert.equal(report.runs[0]!.metrics.toolCalls, 0)
      assert.equal(report.runs[0]!.metrics.retries, 0)
    } finally {
      teardown()
    }
  })

  it('appends records to store file', async () => {
    setup()
    try {
      await runBenchmark({
        suite,
        suiteId: 'suite-1',
        provider: 'openai',
        model: 'gpt-4o',
        storeFile,
        dryRun: true,
      })

      await runBenchmark({
        suite,
        suiteId: 'suite-1',
        provider: 'openai',
        model: 'gpt-4o',
        storeFile,
        dryRun: true,
      })

      // Should have 4 records (2 tasks x 2 runs)
      const content = readFileSync(storeFile, 'utf-8')
      const lines = content.trim().split('\n').filter((l: string) => l.length > 0)
      assert.equal(lines.length, 4)
    } finally {
      teardown()
    }
  })

  it('records executor outcomes and metrics in live mode', async () => {
    setup()
    try {
      const executed: string[] = []
      const report = await runBenchmark({
        suite,
        suiteId: 'suite-live',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        storeFile,
        dryRun: false,
        executor: {
          async execute(task) {
            executed.push(task.id)
            return {
              status: task.id === 'task-1' ? 'passed' : 'failed',
              metrics: { turns: 2, toolCalls: 3, retries: 1 },
              ...(task.id === 'task-2' ? { failures: [{ class: 'verification_failed', message: 'expected file missing' }] } : {}),
            }
          },
        },
      })

      assert.deepEqual(executed, ['task-1', 'task-2'])
      assert.equal(report.runs[0]!.status, 'passed')
      assert.deepEqual(report.runs[0]!.metrics, { turns: 2, toolCalls: 3, retries: 1 })
      assert.equal(report.runs[1]!.failures[0]?.class, 'verification_failed')
    } finally {
      teardown()
    }
  })

  it('rejects live mode without an executor', async () => {
    setup()
    try {
      await assert.rejects(
        runBenchmark({ suite, suiteId: 'suite-live', provider: 'deepseek', model: 'deepseek-v4-pro', storeFile, dryRun: false }),
        /require a BenchmarkExecutor/,
      )
    } finally {
      teardown()
    }
  })
})
