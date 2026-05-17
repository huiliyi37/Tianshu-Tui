import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeMatrixRow, generateMarkdownReport } from '../report.js'
import type { BenchmarkRun, CapabilityMatrixRow } from '../types.js'

function makeRun(
  taskId: string,
  status: BenchmarkRun['status'],
  turns: number,
  toolCalls: number,
  costUsd: number,
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
    metrics: { turns, toolCalls, retries: 0, costUsd },
    failures: [],
  }
}

describe('computeMatrixRow', () => {
  it('computes aggregate stats from runs', () => {
    const runs: BenchmarkRun[] = [
      makeRun('t1', 'passed', 3, 4, 0.001),
      makeRun('t2', 'passed', 5, 8, 0.002),
      makeRun('t3', 'failed', 2, 3, 0.000),
      makeRun('t4', 'blocked', 0, 0, 0.000),
      makeRun('t5', 'passed', 7, 10, 0.003),
    ]

    const row = computeMatrixRow(runs, 'deepseek', 'deepseek-v4-pro', 'r1-local-coding-smoke')

    assert.equal(row.runs, 5)
    assert.equal(row.passed, 3)
    assert.equal(row.failed, 1)
    assert.equal(row.blocked, 1)
    assert.equal(row.passRate, 0.6)
    assert.equal(row.medianTurns, 3)
    assert.equal(row.medianToolCalls, 4)
    assert.equal(row.averageCostUsd, 0.0012)
  })

  it('handles empty runs gracefully', () => {
    const row = computeMatrixRow([], 'openai', 'gpt-4o', 'suite-1')
    assert.equal(row.runs, 0)
    assert.equal(row.passed, 0)
    assert.equal(row.passRate, 0)
    assert.equal(row.medianTurns, 0)
    assert.equal(row.medianToolCalls, 0)
    assert.equal(row.averageCostUsd, 0)
  })

  it('sorts turns correctly for median with even count', () => {
    const runs: BenchmarkRun[] = [
      makeRun('t1', 'passed', 2, 10, 0),
      makeRun('t2', 'passed', 8, 20, 0),
      makeRun('t3', 'passed', 4, 12, 0),
      makeRun('t4', 'passed', 6, 18, 0),
    ]
    const row = computeMatrixRow(runs, 'd', 'm', 's')
    // sorted turns: [2, 4, 6, 8] → median between positions 1 and 2 = (4+6)/2 = 5
    assert.equal(row.medianTurns, 5)
    assert.equal(row.medianToolCalls, 15) // [10, 12, 18, 20] → (12+18)/2 = 15
  })
})

describe('generateMarkdownReport', () => {
  it('generates a markdown table with header', () => {
    const rows: CapabilityMatrixRow[] = [{
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      suiteId: 'r1-local-coding-smoke',
      runs: 10,
      passed: 8,
      failed: 1,
      blocked: 1,
      passRate: 0.8,
      medianTurns: 5,
      medianToolCalls: 8,
      averageCostUsd: 0.003,
    }]

    const md = generateMarkdownReport(rows, 'r1-local-coding-smoke')

    assert.ok(md.includes('# Benchmark Report'))
    assert.ok(md.includes('r1-local-coding-smoke'))
    assert.ok(md.includes('| Provider | Model | Runs | Passed | Failed | Blocked | Pass Rate | Median Turns | Median Tool Calls | Avg Cost (USD) |'))
    assert.ok(md.includes('deepseek'))
    assert.ok(md.includes('deepseek-v4-pro'))
    assert.ok(md.includes('80.0%'))
  })

  it('handles empty rows gracefully', () => {
    const md = generateMarkdownReport([], 'empty-suite')
    assert.ok(md.includes('empty-suite'))
    assert.ok(md.includes('No benchmark runs recorded'))
  })
})
