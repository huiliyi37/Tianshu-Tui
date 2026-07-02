import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { AgentCallbacks, ApprovalMode } from '../loop-types.js'

// C3 (自治模式刹车): in autonomous mode (dangerously-skip-permissions) the run
// pauses cleanly after `checkpointEveryTurns` turns instead of barreling on to
// maxTurns. Supervised modes are unaffected (approvals are their brake).

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-autonomy-cp-'))
writeFileSync(join(TEST_CWD, 'f.txt'), 'hello')

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

/** Emits a read_file tool_use for `toolTurns` calls, then a final text turn. */
function makeToolClient(toolTurns: number): StreamClient & { calls: () => number } {
  let callCount = 0
  return {
    calls: () => callCount,
    stream: async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      callCount++
      if (callCount <= toolTurns) {
        cb.onContentBlock({ type: 'tool_use', id: `tu_${callCount}`, name: 'read_file', input: { file_path: join(TEST_CWD, 'f.txt') } })
        cb.onStopReason('tool_use', { input_tokens: 150, output_tokens: 80 })
      } else {
        cb.onTextDelta('done')
        cb.onContentBlock({ type: 'text', text: 'done' })
        cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
      }
    },
  } as unknown as StreamClient & { calls: () => number }
}

function makeCallbacks(checkpoints: number[]): AgentCallbacks {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (error: Error) => { throw error },
    onAbort: () => {},
    onApprovalRequired: async () => true,
    onAutonomyCheckpoint: (turns) => { checkpoints.push(turns) },
  }
}

function makeAgent(client: StreamClient, opts: { checkpointEveryTurns?: number; approvalMode?: ApprovalMode }): AgentLoop {
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client,
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 20,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    ...(opts.checkpointEveryTurns !== undefined ? { checkpointEveryTurns: opts.checkpointEveryTurns } : {}),
    ...(opts.approvalMode ? { approvalMode: opts.approvalMode } : {}),
  }, new SessionContext(), TEST_CWD)
}

describe('TurnOrchestrator: autonomy checkpoint (C3)', () => {
  it('autonomous mode pauses after checkpointEveryTurns turns', async () => {
    const client = makeToolClient(10) // would run 11 turns unchecked
    const checkpoints: number[] = []
    const agent = makeAgent(client, { checkpointEveryTurns: 3, approvalMode: 'dangerously-skip-permissions' })

    await agent.run('read the file repeatedly', makeCallbacks(checkpoints))

    assert.equal(client.calls(), 3, 'run must stop after 3 turns at the checkpoint')
    assert.deepEqual(checkpoints, [3], 'onAutonomyCheckpoint fires once with the turn count')
  })

  it('supervised mode ignores the checkpoint (approvals are the brake)', async () => {
    const client = makeToolClient(5)
    const checkpoints: number[] = []
    const agent = makeAgent(client, { checkpointEveryTurns: 3, approvalMode: 'auto-safe' })

    await agent.run('read the file repeatedly', makeCallbacks(checkpoints))

    assert.equal(client.calls(), 6, 'supervised run proceeds to its natural finish')
    assert.deepEqual(checkpoints, [], 'no checkpoint event outside autonomous mode')
  })

  it('checkpointEveryTurns=0 disables the brake in autonomous mode', async () => {
    const client = makeToolClient(5)
    const checkpoints: number[] = []
    const agent = makeAgent(client, { checkpointEveryTurns: 0, approvalMode: 'dangerously-skip-permissions' })

    await agent.run('read the file repeatedly', makeCallbacks(checkpoints))

    assert.equal(client.calls(), 6)
    assert.deepEqual(checkpoints, [])
  })
})
