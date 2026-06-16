import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'

// Regression guard for the loop-split refactor that silently orphaned the
// cognitive projection (cognitive-mirror) injection. These tests pin the
// producer→engine wiring so it cannot be dropped again without going RED.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-cogproj-'))

function textOnlyClient(text = 'done'): StreamClient {
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      cb.onTextDelta(text)
      cb.onContentBlock({ type: 'text', text })
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    }),
  } as unknown as StreamClient
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function makeCallbacks() {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (e: Error) => { throw e },
    onAbort: () => {},
    onApprovalRequired: async () => false,
  }
}

function makeAgent(engine: PromptEngine): { agent: AgentLoop; session: SessionContext } {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  const agent = new AgentLoop({
    client: textOnlyClient(),
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, TEST_CWD)
  return { agent, session }
}

describe('cognitive projection wiring', () => {
  it('injects <cognitive-mirror> on an actionable task turn', async () => {
    const engine = makeEngine()
    const spy = mock.method(engine, 'setCognitiveProjection')
    const { agent } = makeAgent(engine)

    await agent.run('add a function to src/foo.ts to compute totals', makeCallbacks())

    const args = spy.mock.calls.map(c => c.arguments[0])
    const injected = args.filter((a): a is string => typeof a === 'string' && a.includes('<cognitive-mirror'))
    assert.ok(injected.length > 0, `expected a cognitive-mirror projection, got: ${JSON.stringify(args)}`)
    assert.ok(agent.getCognitiveSnapshot() !== undefined, 'cognitive snapshot should be populated after a turn')
  })

  it('clears the projection on a non-actionable chat turn', async () => {
    const engine = makeEngine()
    const spy = mock.method(engine, 'setCognitiveProjection')
    const { agent } = makeAgent(engine)

    await agent.run('hello', makeCallbacks())

    const args = spy.mock.calls.map(c => c.arguments[0])
    assert.ok(args.some(a => a === null), 'chat turn should clear cognitive projection with null')
    assert.ok(
      !args.some(a => typeof a === 'string' && a.includes('<cognitive-mirror')),
      `chat turn must not inject a cognitive-mirror, got: ${JSON.stringify(args)}`,
    )
  })
})
