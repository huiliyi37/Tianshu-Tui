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
import type { ContentBlock } from '../../api/types.js'

// Safety net for the loop.ts terminal-wave (turn-step producer) extraction.
// These tests lock the prefix-cache setter timing invariants documented in
// .rivet/plans/loop拆分-交接-W-L5至L8进度与缓存时序缰绳.md §3 so the mechanical
// move of initializeRun / buildTurnRequest / runPerception cannot drift them:
//   1. A-class invalidation (invalidateFreshCache) only fires at the user-message
//      boundary (before the first buildOaiRequest), never between tool turns.
//   2. refreshGitContextIfNeeded(await) + the harness advisory setter complete
//      before buildOaiRequest on EVERY turn.
//   3. Per-message invalidation count does not scale with tool-turn count
//      (fresh cache survives the tool loop).

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-cache-timing-'))
writeFileSync(join(TEST_CWD, 'f.txt'), 'hello')

function makeTextBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

function makeCallbacks() {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (error: Error) => { throw error },
    onAbort: () => {},
    onApprovalRequired: async () => false,
  }
}

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

/**
 * Mock client that emits a tool_use for the first `toolTurns` calls, then a
 * final end_turn — drives exactly `toolTurns + 1` turns (and thus the same
 * number of buildOaiRequest calls) within a single user message.
 */
function makeMultiTurnClient(toolTurns: number): StreamClient {
  let callCount = 0
  return {
    stream: async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      callCount++
      if (callCount <= toolTurns) {
        cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'read_file', { file_path: join(TEST_CWD, 'f.txt') }))
        cb.onStopReason('tool_use', { input_tokens: 150, output_tokens: 80 })
      } else {
        cb.onTextDelta('done')
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
      }
    },
  } as unknown as StreamClient
}

/** Replaces a method with an order-recording wrapper that still calls through. */
function spyOrder(engine: PromptEngine, key: string, label: string, order: string[]): void {
  const target = engine as unknown as Record<string, (...args: unknown[]) => unknown>
  const orig = target[key]!.bind(engine)
  target[key] = (...args: unknown[]) => {
    order.push(label)
    return orig(...args)
  }
}

function makeAgent(engine: PromptEngine, client: StreamClient, session: SessionContext): AgentLoop {
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client,
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 10,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, TEST_CWD)
}

describe('turn-step cache setter timing (terminal-wave safety net)', () => {
  it('A-class invalidation only fires at the user-message boundary, never between tool turns', async () => {
    const engine = makeEngine()
    const order: string[] = []
    spyOrder(engine, 'invalidateFreshCache', 'invalidate', order)
    spyOrder(engine, 'buildOaiRequest', 'build', order)

    const agent = makeAgent(engine, makeMultiTurnClient(3), new SessionContext())
    await agent.run('read the file', makeCallbacks())

    const firstBuild = order.indexOf('build')
    const lastInvalidate = order.lastIndexOf('invalidate')
    assert.ok(firstBuild >= 0, 'expected at least one buildOaiRequest call')
    assert.ok(lastInvalidate >= 0, 'expected at least one invalidateFreshCache call at the boundary')
    assert.ok(
      lastInvalidate < firstBuild,
      `fresh cache was invalidated mid tool-loop: last invalidate=${lastInvalidate} >= first build=${firstBuild} (order=${order.join(',')})`,
    )
  })

  it('refreshGitContextIfNeeded and the harness setter complete before buildOaiRequest on every turn', async () => {
    const engine = makeEngine()
    const order: string[] = []
    spyOrder(engine, 'setHarnessAdvisoryBlock', 'harness', order)
    spyOrder(engine, 'refreshGitContextIfNeeded', 'git', order)
    spyOrder(engine, 'buildOaiRequest', 'build', order)

    const agent = makeAgent(engine, makeMultiTurnClient(2), new SessionContext())
    await agent.run('read the file', makeCallbacks())

    // git must precede build on every turn: filtered to git/build it strictly
    // alternates git,build,git,build,... (never a build without a fresh git).
    const gitBuild = order.filter(x => x === 'git' || x === 'build')
    assert.ok(gitBuild.length > 0 && gitBuild.length % 2 === 0, `unbalanced git/build sequence: ${gitBuild.join(',')}`)
    for (let i = 0; i < gitBuild.length; i += 2) {
      assert.equal(gitBuild[i], 'git', `expected git before build at pair ${i / 2}: ${gitBuild.join(',')}`)
      assert.equal(gitBuild[i + 1], 'build', `expected build after git at pair ${i / 2}: ${gitBuild.join(',')}`)
    }

    // harness advisory setter precedes build on every turn likewise.
    const harnessBuild = order.filter(x => x === 'harness' || x === 'build')
    assert.ok(harnessBuild.length > 0 && harnessBuild.length % 2 === 0, `unbalanced harness/build sequence: ${harnessBuild.join(',')}`)
    for (let i = 0; i < harnessBuild.length; i += 2) {
      assert.equal(harnessBuild[i], 'harness', `expected harness before build at pair ${i / 2}: ${harnessBuild.join(',')}`)
      assert.equal(harnessBuild[i + 1], 'build', `expected build after harness at pair ${i / 2}: ${harnessBuild.join(',')}`)
    }
  })

  it('per-message invalidation count does not scale with tool-turn count (fresh cache survives the loop)', async () => {
    const countInvalidations = async (toolTurns: number): Promise<number> => {
      const engine = makeEngine()
      const order: string[] = []
      spyOrder(engine, 'invalidateFreshCache', 'invalidate', order)
      const agent = makeAgent(engine, makeMultiTurnClient(toolTurns), new SessionContext())
      await agent.run('read the file', makeCallbacks())
      return order.filter(x => x === 'invalidate').length
    }

    const oneTurn = await countInvalidations(0)
    const manyTurns = await countInvalidations(4)
    assert.equal(
      manyTurns,
      oneTurn,
      `invalidation count scaled with tool turns: 1-turn=${oneTurn} vs 5-turn=${manyTurns} (A-class setter leaked into the tool loop)`,
    )
  })

  it('A-class updateTools fingerprint recalculation is never triggered mid-loop', async () => {
    const engine = makeEngine()
    const order: string[] = []
    spyOrder(engine, 'updateTools', 'updateTools', order)
    spyOrder(engine, 'buildOaiRequest', 'build', order)

    const agent = makeAgent(engine, makeMultiTurnClient(3), new SessionContext())
    await agent.run('read the file', makeCallbacks())

    // updateTools recalculates fingerprint directly (not via invalidateFreshCache).
    // It must NEVER fire between the first buildOaiRequest and the end of the run —
    // a mid-loop fingerprint change would break prefix cache across tool turns.
    const builds = order.filter(x => x === 'build')
    const updates = order.filter(x => x === 'updateTools')
    assert.ok(builds.length > 0, 'expected at least one buildOaiRequest call')
    assert.equal(
      updates.length,
      0,
      `updateTools (fingerprint recalculation) fired mid-loop: ${order.join(',')} (A-class fingerprint mutation leaked into the tool loop)`,
    )
  })
})
