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
      execute: async () => ({ content: 'file content' }),
      classify: () => undefined,
    })
    assert.equal(result.content, 'file content')
    assert.equal(result.isError, false)
    assert.equal(trajectory.getEntries().length, 1)
    assert.equal(trajectory.getEntries()[0]!.status, 'success')
  })

  it('retries transient errors once then succeeds', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    let calls = 0
    const result = await harness.executeTool({
      id: 'tu2',
      name: 'bash',
      input: { command: 'npm test' },
      execute: async () => {
        calls++
        if (calls === 1) return { content: 'Error: ETIMEDOUT', isError: true }
        return { content: 'ok' }
      },
      classify: (content) => content.includes('ETIMEDOUT') ? 'timeout' : undefined,
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
      execute: async () => { calls++; return { content: 'Type error TS2345', isError: true } },
      classify: () => 'type_error',
    })
    assert.equal(calls, 1)
    assert.equal(result.isError, true)
    assert.equal(trajectory.getEntries()[0]!.status, 'failed')
  })

  it('retries once then fails with reflexion hint', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    const result = await harness.executeTool({
      id: 'tu4',
      name: 'bash',
      input: { command: 'curl api' },
      execute: async () => ({ content: 'ECONNRESET', isError: true }),
      classify: () => 'timeout',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('[Retry failed.'))
    assert.equal(trajectory.getEntries()[0]!.status, 'retried-failed')
  })

  it('calls onBeforeTool and onAfterTool hooks', async () => {
    const trajectory = new TrajectoryRecorder()
    const hooks: string[] = []
    const harness = new TurnHarness({
      ...makeConfig(),
      onBeforeTool: (name) => { hooks.push(`before:${name}`) },
      onAfterTool: (name, _r, isErr) => { hooks.push(`after:${name}:${isErr}`) },
    }, trajectory)
    await harness.executeTool({
      id: 'tu5',
      name: 'grep',
      input: { pattern: 'x' },
      execute: async () => ({ content: 'match' }),
      classify: () => undefined,
    })
    assert.deepEqual(hooks, ['before:grep', 'after:grep:false'])
  })

  it('respects retryableClasses allowlist', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig({ retryableClasses: ['flaky'] }), trajectory)
    let calls = 0
    const result = await harness.executeTool({
      id: 'tu6',
      name: 'bash',
      input: { command: 'curl' },
      execute: async () => { calls++; return { content: 'timeout', isError: true } },
      classify: () => 'timeout',
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
      execute: async () => {
        calls++
        if (calls === 1) return { content: 'intermittent failure', isError: true }
        return { content: 'all passed' }
      },
      classify: () => 'flaky',
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
      execute: async () => ({ content: 'ok' }),
      classify: () => undefined,
    })
    assert.equal(trajectory.getEntries()[0]!.target, 'src/lib/helper.ts')
  })

  it('truncates command target to 50 chars', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    const longCmd = 'a'.repeat(100)
    await harness.executeTool({
      id: 'tu9',
      name: 'bash',
      input: { command: longCmd },
      execute: async () => ({ content: 'ok' }),
      classify: () => undefined,
    })
    assert.ok(trajectory.getEntries()[0]!.target.length <= 50)
  })
})
