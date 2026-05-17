import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendBenchmarkRun, readBenchmarkRuns } from '../store.js'
import type { BenchmarkRun } from '../types.js'

function makeRun(
  taskId: string,
  status: BenchmarkRun['status'],
  overrides?: Partial<BenchmarkRun>,
): BenchmarkRun {
  return {
    runId: `run-${taskId}`,
    suiteId: 'r1-local-coding-smoke',
    taskId,
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    status,
    startedAt: '2026-05-17T12:00:00.000Z',
    endedAt: '2026-05-17T12:01:00.000Z',
    metrics: { turns: 3, toolCalls: 4, retries: 0, cacheHitRate: 0.98, costUsd: 0.002 },
    failures: [],
    ...overrides,
  }
}

describe('benchmark store', () => {
  let dir: string
  let file: string

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'rivet-bench-'))
    file = join(dir, 'runs.jsonl')
  }

  function teardown() {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }

  it('appendBenchmarkRun writes parseable JSONL records', () => {
    setup()
    try {
      appendBenchmarkRun(file, makeRun('task-a', 'passed'))
      appendBenchmarkRun(file, makeRun('task-b', 'failed'))

      const lines = readBenchmarkRuns(file)
      assert.equal(lines.length, 2)
      assert.equal(lines[0]!.taskId, 'task-a')
      assert.equal(lines[0]!.status, 'passed')
      assert.equal(lines[1]!.taskId, 'task-b')
      assert.equal(lines[1]!.status, 'failed')
    } finally {
      teardown()
    }
  })

  it('readBenchmarkRuns returns empty array for missing file', () => {
    setup()
    try {
      const missing = join(dir, 'nonexistent.jsonl')
      const results = readBenchmarkRuns(missing)
      assert.deepStrictEqual(results, [])
    } finally {
      teardown()
    }
  })

  it('readBenchmarkRuns filters by suiteId', () => {
    setup()
    try {
      appendBenchmarkRun(file, makeRun('task-a', 'passed', { suiteId: 'suite-1' }))
      appendBenchmarkRun(file, makeRun('task-b', 'passed', { suiteId: 'suite-2' }))
      appendBenchmarkRun(file, makeRun('task-c', 'blocked', { suiteId: 'suite-1' }))

      const results = readBenchmarkRuns(file, { suiteId: 'suite-1' })
      assert.equal(results.length, 2)
      assert.ok(results.every(r => r.suiteId === 'suite-1'))
    } finally {
      teardown()
    }
  })

  it('readBenchmarkRuns filters by taskId', () => {
    setup()
    try {
      appendBenchmarkRun(file, makeRun('task-a', 'passed'))
      appendBenchmarkRun(file, makeRun('task-b', 'failed'))
      appendBenchmarkRun(file, makeRun('task-a', 'blocked'))

      const results = readBenchmarkRuns(file, { taskId: 'task-a' })
      assert.equal(results.length, 2)
      assert.ok(results.every(r => r.taskId === 'task-a'))
    } finally {
      teardown()
    }
  })

  it('appendBenchmarkRun creates parent directory if missing', () => {
    setup()
    try {
      const nested = join(dir, 'nested', 'deep', 'runs.jsonl')
      appendBenchmarkRun(nested, makeRun('task-d', 'blocked'))
      assert.ok(existsSync(nested))
      const results = readBenchmarkRuns(nested)
      assert.equal(results.length, 1)
    } finally {
      teardown()
    }
  })
})
