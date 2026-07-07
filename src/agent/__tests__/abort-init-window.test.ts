import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-abort-window-'))

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function makeAgent(client: StreamClient) {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client,
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 5,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    fsWatcherEnabled: false,
  }, session, TEST_CWD)
}

const cbs = (onAbort: () => void) => ({
  onTextDelta: () => {},
  onThinkingDelta: () => {},
  onToolUse: () => {},
  onToolResult: () => {},
  onTurnComplete: () => {},
  onError: () => {},
  onAbort,
  onApprovalRequired: async () => false,
})

describe('AgentLoop — abort init-window (A)', () => {
  it('creates the abortController eagerly before any await in run()', () => {
    const client: StreamClient = {
      stream: async (_r: unknown, cb: StreamCallbacks) => { cb.onStopReason('end_turn', {}) },
    } as unknown as StreamClient
    const agent = makeAgent(client)
    assert.equal(agent.abortController, null, 'no controller before run')
    const p = agent.run('hello', cbs(() => {}))
    // Synchronously after run() returns its pending promise we are parked on the
    // first await (warmupMemories); the controller must already exist.
    assert.ok(agent.abortController, 'controller created eagerly (no null window)')
    return p
  })

  it('honors abort fired during the init/warmup window (no longer a no-op)', async () => {
    let streamCalls = 0
    const client: StreamClient = {
      stream: async (_r: unknown, cb: StreamCallbacks) => {
        streamCalls++
        cb.onStopReason('end_turn', {})
      },
    } as unknown as StreamClient
    const agent = makeAgent(client)

    let aborted = false
    const p = agent.run('do something', cbs(() => { aborted = true }))
    // Abort while parked in the init window (before the turn loop / first stream).
    agent.abort()
    assert.equal(agent.abortController!.signal.aborted, true, 'abort took effect, not swallowed')

    await p
    assert.equal(aborted, true, 'onAbort fired')
    assert.equal(streamCalls, 0, 'bailed before the first stream')
  })

  it('a fresh run after an aborted one starts with a clean (non-aborted) signal', async () => {
    const client: StreamClient = {
      stream: async (_r: unknown, cb: StreamCallbacks) => {
        cb.onTextDelta('hi')
        cb.onContentBlock({ type: 'text', text: 'hi' })
        cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
      },
    } as unknown as StreamClient
    const agent = makeAgent(client)

    const p1 = agent.run('first', cbs(() => {}))
    agent.abort()
    await p1

    // Second run must not inherit the previous aborted signal.
    await agent.run('second', cbs(() => {}))
    assert.equal(agent.abortController!.signal.aborted, false, 'new run resets pending abort')
  })
})
