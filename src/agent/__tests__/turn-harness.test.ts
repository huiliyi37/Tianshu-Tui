import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TurnHarness, type TurnHarnessConfig } from '../turn-harness.js'
import { TrajectoryRecorder } from '../trajectory.js'

function makeConfig(overrides?: Partial<TurnHarnessConfig>): TurnHarnessConfig {
  return {
    maxRetries: 1,
    retryableClasses: ['timeout', 'flaky'],
    ...overrides,
  }
}

describe('TurnHarness', () => {
  it('executes a tool and records trajectory', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    const result = await harness.executeTool({
      id: 'tu1',
      name: 'read_file',
      input: { file_path: 'src/a.ts' },
      turn: 1,
      execute: async () => ({ content: 'file content' }),
      classify: () => undefined,
      isConcurrencySafe: true,
    })
    assert.equal(result.content, 'file content')
    assert.equal(result.isError, false)
    assert.equal(trajectory.getEntries().length, 1)
    assert.equal(trajectory.getEntries()[0]!.status, 'success')
  })

  it('records correct turn number', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    await harness.executeTool({
      id: 'tu1b',
      name: 'read_file',
      input: { file_path: 'a.ts' },
      turn: 3,
      execute: async () => ({ content: 'ok' }),
      classify: () => undefined,
      isConcurrencySafe: true,
    })
    assert.equal(trajectory.getEntries()[0]!.turn, 3)
  })

  it('retries transient errors once then succeeds', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    let calls = 0
    const result = await harness.executeTool({
      id: 'tu2',
      name: 'bash',
      input: { command: 'npm test' },
      turn: 1,
      execute: async () => {
        calls++
        if (calls === 1) return { content: 'Error: ETIMEDOUT', isError: true }
        return { content: 'ok' }
      },
      classify: (content) => content.includes('ETIMEDOUT') ? 'timeout' : undefined,
      isConcurrencySafe: true,
    })
    assert.equal(calls, 2)
    assert.equal(result.content, 'ok')
    assert.equal(result.isError, false)
    assert.equal(trajectory.getEntries().length, 1)
    assert.equal(trajectory.getEntries()[0]!.status, 'retried-success')
  })

  it('does not retry non-transient errors', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    let calls = 0
    const result = await harness.executeTool({
      id: 'tu3',
      name: 'edit_file',
      input: { file_path: 'x.ts' },
      turn: 1,
      execute: async () => { calls++; return { content: 'Type error TS2345', isError: true } },
      classify: () => 'type_error',
      isConcurrencySafe: true,
    })
    assert.equal(calls, 1)
    assert.equal(result.isError, true)
    assert.equal(trajectory.getEntries()[0]!.status, 'failed')
  })

  it('retries once then fails with reflection hint', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    const result = await harness.executeTool({
      id: 'tu4',
      name: 'bash',
      input: { command: 'curl api' },
      turn: 1,
      execute: async () => ({ content: 'ECONNRESET', isError: true }),
      classify: () => 'timeout',
      isConcurrencySafe: true,
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('[All 1 retries failed.'))
    assert.equal(trajectory.getEntries()[0]!.status, 'retried-failed')
  })

  it('retries up to maxRetries attempts', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig({ maxRetries: 3, retryableClasses: ['timeout'] }), trajectory)
    let calls = 0
    const result = await harness.executeTool({
      id: 'tu4b',
      name: 'bash',
      input: { command: 'curl api' },
      turn: 1,
      execute: async () => { calls++; return { content: 'ECONNRESET', isError: true } },
      classify: () => 'timeout',
      isConcurrencySafe: true,
    })
    assert.equal(calls, 4) // 1 initial + 3 retries
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('[All 3 retries failed.'))
    assert.equal(trajectory.getEntries()[0]!.status, 'retried-failed')
  })

  it('respects retryableClasses allowlist', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig({ retryableClasses: ['flaky'] }), trajectory)
    let calls = 0
    const result = await harness.executeTool({
      id: 'tu6',
      name: 'bash',
      input: { command: 'curl' },
      turn: 1,
      execute: async () => { calls++; return { content: 'timeout', isError: true } },
      classify: () => 'timeout',
      isConcurrencySafe: true,
    })
    assert.equal(calls, 1)
    assert.equal(result.isError, true)
    assert.equal(result.retried, false)
  })

  it('retries flaky errors', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    let calls = 0
    const result = await harness.executeTool({
      id: 'tu7',
      name: 'run_tests',
      input: { command: 'npm test' },
      turn: 1,
      execute: async () => {
        calls++
        if (calls === 1) return { content: 'intermittent failure', isError: true }
        return { content: 'all passed' }
      },
      classify: () => 'flaky',
      isConcurrencySafe: true,
    })
    assert.equal(calls, 2)
    assert.equal(result.retried, true)
    assert.equal(result.isError, false)
  })

  it('extracts target from path input', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    await harness.executeTool({
      id: 'tu8',
      name: 'read_file',
      input: { path: 'src/lib/helper.ts' },
      turn: 1,
      execute: async () => ({ content: 'ok' }),
      classify: () => undefined,
      isConcurrencySafe: true,
    })
    assert.equal(trajectory.getEntries()[0]!.target, 'src/lib/helper.ts')
  })

  it('treats maxRetries as retry attempts after the first execution', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig({ maxRetries: 2, retryableClasses: ['timeout'] }), trajectory)
    let attempts = 0
    const result = await harness.executeTool({
      id: 'tu_retry',
      name: 'bash',
      input: { command: 'npm test' },
      turn: 1,
      execute: async () => {
        attempts++
        return { content: attempts < 3 ? 'Command timed out' : 'ok', isError: attempts < 3 }
      },
      classify: content => content.includes('timed out') ? 'timeout' : undefined,
      isConcurrencySafe: true,
    })
    assert.equal(attempts, 3) // 1 initial + 2 retries
    assert.equal(result.isError, false)
    assert.equal(result.retried, true)
  })

  it('does not retry failures whose class is not in retryableClasses', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig({ maxRetries: 2, retryableClasses: ['timeout'] }), trajectory)
    let attempts = 0
    const result = await harness.executeTool({
      id: 'tu_noretry',
      name: 'bash',
      input: { command: 'npm test' },
      turn: 1,
      execute: async () => { attempts++; return { content: 'intermittent failure', isError: true } },
      classify: () => 'flaky',
      isConcurrencySafe: true,
    })
    assert.equal(attempts, 1) // flaky is transient but not in retryableClasses
    assert.equal(result.isError, true)
    assert.equal(result.retried, false)
  })

  it('truncates command target to 50 chars', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    const longCmd = 'a'.repeat(100)
    await harness.executeTool({
      id: 'tu9',
      name: 'bash',
      input: { command: longCmd },
      turn: 1,
      execute: async () => ({ content: 'ok' }),
      classify: () => undefined,
      isConcurrencySafe: true,
    })
    assert.ok(trajectory.getEntries()[0]!.target.length <= 50)
  })
})
