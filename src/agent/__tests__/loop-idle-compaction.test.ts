import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { StreamClient } from '../../api/stream-client.js'

const CWD = mkdtempSync(join(tmpdir(), 'rivet-idle-'))

function makeAgent(compactEnabled: boolean): AgentLoop {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  const client = { stream: async () => {} } as unknown as StreamClient
  const engine = new PromptEngine({ model: 'deepseek-v4-pro', maxTokens: 1024, staticCtx: { tools: [READ_FILE_TOOL.definition] }, volatileCtx: { cwd: CWD } })
  return new AgentLoop({
    client,
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 5,
    contextWindow: 1_000_000,
    compact: { enabled: compactEnabled, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, CWD)
}

function mockCoordinator(agent: AgentLoop) {
  const fn = mock.fn(async () => ({ compacted: false, shouldAbort: false, userMessageConsumed: false }))
  agent.compactBoundaryCoordinator.runCompaction = fn as never
  return fn
}

describe('AgentLoop idle compaction', () => {
  it('runs a turn-0 (turn=0, snap=null) pass when there is deferred pending work', async () => {
    const agent = makeAgent(true)
    const fn = mockCoordinator(agent)
    agent.pendingStaleCompact = true

    await agent.runIdleCompaction()

    assert.equal(fn.mock.callCount(), 1, 'coordinator.runCompaction must be called')
    assert.deepEqual(fn.mock.calls[0]!.arguments, [0, null], 'must run at turn=0 with null snapshot')
  })

  it('skips when there is no pending work and pressure is low', async () => {
    const agent = makeAgent(true)
    const fn = mockCoordinator(agent)
    // fresh session → ratio ≈ 0, no pending flags
    await agent.runIdleCompaction()
    assert.equal(fn.mock.callCount(), 0, 'must skip at low fill with no deferred work')
  })

  it('is a no-op when discretionary compaction is disabled', async () => {
    const agent = makeAgent(false)
    const fn = mockCoordinator(agent)
    agent.pendingStaleCompact = true
    await agent.runIdleCompaction()
    assert.equal(fn.mock.callCount(), 0, 'disabled compaction must not run idle passes')
  })

  it('cancelIdleCompaction aborts an in-flight pass and resolves after it settles', async () => {
    const agent = makeAgent(true)
    agent.pendingHeapCompact = true
    let observedSignal: AbortSignal | undefined
    let release: () => void
    const gate = new Promise<void>((r) => { release = r })
    agent.compactBoundaryCoordinator.runCompaction = (async () => {
      observedSignal = agent.abortController?.signal
      await gate
      return { compacted: false, shouldAbort: false, userMessageConsumed: false }
    }) as never

    const inflight = agent.runIdleCompaction()
    // let the async body start and capture the signal
    await Promise.resolve()
    await Promise.resolve()

    const cancel = agent.cancelIdleCompaction()
    assert.equal(observedSignal?.aborted, true, 'idle abort signal must be aborted by cancel')
    release!()
    await cancel
    await inflight
  })
})
