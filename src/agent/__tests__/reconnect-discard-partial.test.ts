/**
 * Stream reconnect — partial blocks discard invariant.
 *
 * When a stream fails mid-delivery (after emitting some text deltas / content
 * blocks) and the agent reconnects, the partial output from the failed stream
 * must NOT persist into the session:
 *   - No addAssistantBlocks with partial collected blocks
 *   - streamedText reset to '' before reconnect
 *   - On successful retry, only the retry's output is persisted
 *
 * This guards prefix cache: partial blocks in the message list would shift the
 * anchor and poison the cache prefix for subsequent turns.
 *
 * Anti-regression: if the orchestrator forgets to reset state before reconnect,
 * the failed stream's text leaks into session.addAssistantBlocks.
 */
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
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-reconnect-partial-'))

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function reconnectError(): Error {
  // status 503 → classifyApiError().shouldReconnect === true
  return Object.assign(new Error('Server overloaded (503)'), { status: 503 })
}

/**
 * Client that on call 1: streams partial text "PARTIAL_" then throws 503.
 * On call 2: streams clean text "CLEAN" and succeeds.
 *
 * The partial text "PARTIAL_" must NOT appear in the final session messages.
 */
function makePartialFailClient(): StreamClient {
  let calls = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      calls++
      if (calls === 1) {
        // Emit partial text, then fail mid-stream
        cb.onTextDelta('PARTIAL_')
        throw reconnectError()
      }
      // Call 2: clean success
      cb.onTextDelta('CLEAN')
      cb.onContentBlock({ type: 'text', text: 'CLEAN' })
      cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    }),
  } as unknown as StreamClient
}

describe('Stream reconnect — partial blocks discard', () => {
  it('discards partial output from failed stream, only persists retry output', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const client = makePartialFailClient()

    const agent = new AgentLoop({
      client, promptEngine: makeEngine(), toolRegistry: registry,
      maxTurns: 1, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      agentReconnect: { enabled: true, maxAttempts: 2, backoffMs: 1 },
    }, session, TEST_CWD)

    const texts: string[] = []
    let errored: Error | null = null
    let completed = false

    await agent.run('hi', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => { completed = true },
      onError: (e) => { errored = e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    // Reconnect succeeded → no error, turn completed
    assert.equal(errored, null, 'reconnect should succeed, no error')
    assert.equal(completed, true, 'turn should complete normally')

    // The session must contain only the retry's assistant message, not partial
    const messages = session.getMessages()
    const assistantMsgs = messages.filter(m => m.role === 'assistant')
    assert.equal(assistantMsgs.length, 1, 'exactly one assistant message (from retry)')

    // The persisted text must be 'CLEAN', not 'PARTIAL_CLEAN' or 'PARTIAL_'
    const assistantText = typeof assistantMsgs[0]!.content === 'string'
      ? assistantMsgs[0]!.content
      : JSON.stringify(assistantMsgs[0]!.content)
    assert.ok(
      !assistantText.includes('PARTIAL'),
      `partial text must NOT persist in session — got: ${assistantText}`
    )
    assert.ok(
      assistantText.includes('CLEAN'),
      `retry text must persist — got: ${assistantText}`
    )
  })

  it('does not call addAssistantBlocks with partial blocks on failed stream', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    // Client that streams a content block then fails, then succeeds with different text
    let calls = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        calls++
        if (calls === 1) {
          // Emit a text block then fail — this block must be discarded
          cb.onContentBlock({ type: 'text', text: 'POISONED_PARTIAL' })
          throw reconnectError()
        }
        cb.onContentBlock({ type: 'text', text: 'GOOD_OUTPUT' })
        cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client, promptEngine: makeEngine(), toolRegistry: registry,
      maxTurns: 1, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      agentReconnect: { enabled: true, maxAttempts: 1, backoffMs: 1 },
    }, session, TEST_CWD)

    await agent.run('hi', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const messages = session.getMessages()
    // No assistant message should contain the poisoned partial text
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      assert.ok(
        !content.includes('POISONED'),
        `poisoned partial block must NOT appear in any message — found in: ${content}`
      )
    }
  })
})
