import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  taskDefinitionSchema,
  benchmarkRunSchema,
  capabilityMatrixRowSchema,
} from '../types.js'

describe('benchmark taskDefinitionSchema', () => {
  it('parses a minimal task definition', () => {
    const result = taskDefinitionSchema.safeParse({
      id: 'task-1',
      title: 'Read a file',
      category: 'repo_inspection',
      prompt: 'Read the README.md file',
      timeoutMs: 30000,
    })
    assert.ok(result.success)
    assert.equal(result.data!.id, 'task-1')
    assert.deepStrictEqual(result.data!.setupCommands, [])
    assert.deepStrictEqual(result.data!.successCommands, [])
  })

  it('rejects missing required fields', () => {
    const result = taskDefinitionSchema.safeParse({})
    assert.ok(!result.success)
  })

  it('rejects invalid category', () => {
    const result = taskDefinitionSchema.safeParse({
      id: 'x',
      title: 'X',
      category: 'invalid_category',
      prompt: 'do stuff',
      timeoutMs: 1000,
    })
    assert.ok(!result.success)
  })
})

describe('benchmark benchmarkRunSchema', () => {
  it('parses a valid run record', () => {
    const result = benchmarkRunSchema.safeParse({
      runId: 'run-uuid-1',
      suiteId: 'r1-local-coding-smoke',
      taskId: 'task-1',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      status: 'blocked',
      startedAt: '2026-05-17T12:00:00.000Z',
      endedAt: '2026-05-17T12:01:00.000Z',
      metrics: { turns: 3, toolCalls: 4, retries: 0, cacheHitRate: 0.98, costUsd: 0.002 },
      failures: [],
    })
    assert.ok(result.success)
    assert.equal(result.data!.status, 'blocked')
    assert.equal(result.data!.metrics.turns, 3)
  })

  it('defaults failures to empty array', () => {
    const result = benchmarkRunSchema.safeParse({
      runId: 'run-uuid-2',
      suiteId: 's1',
      taskId: 't1',
      provider: 'openai',
      model: 'gpt-4o',
      status: 'passed',
      startedAt: '2026-05-17T12:00:00.000Z',
      endedAt: '2026-05-17T12:01:00.000Z',
      metrics: { turns: 0, toolCalls: 0, retries: 0 },
    })
    assert.ok(result.success)
    assert.deepStrictEqual(result.data!.failures, [])
  })
})

describe('benchmark capabilityMatrixRowSchema', () => {
  it('parses a valid matrix row', () => {
    const result = capabilityMatrixRowSchema.safeParse({
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
    })
    assert.ok(result.success)
    assert.equal(result.data!.passRate, 0.8)
    assert.equal(result.data!.passed, 8)
  })
})
