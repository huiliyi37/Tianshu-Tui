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

  it('produces blocked records for all tasks in dry-run mode', () => {
    setup()
    try {
      const report = runBenchmark({
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

  it('appends records to store file', () => {
    setup()
    try {
      runBenchmark({
        suite,
        suiteId: 'suite-1',
        provider: 'openai',
        model: 'gpt-4o',
        storeFile,
        dryRun: true,
      })

      runBenchmark({
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
})
