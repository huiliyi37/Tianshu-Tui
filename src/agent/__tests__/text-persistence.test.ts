/**
 * Regression tests for the cross-turn re-answer bug.
 *
 * Root cause: the production OpenAI-compatible client streams text only via
 * onTextDelta and never emits onContentBlock({type:'text'}). The loop persists
 * assistant turns exclusively from collected content blocks, so text-only
 * replies were displayed in the TUI but never written to session history.
 * On the next user message the model saw the previous user message as
 * unanswered and re-answered it before (or after) the new task.
 *
 * These tests use a delta-only mock client that mimics the real client's
 * pre-fix behavior, and assert the loop still persists the visible text.
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

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-text-persist-'))

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function makeAgent(client: StreamClient, session: SessionContext, maxTurns = 5) {
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client, promptEngine: makeEngine(), toolRegistry: registry,
    maxTurns, contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, TEST_CWD)
}

function makeCallbacks(overrides: Partial<Parameters<AgentLoop['run']>[1]> = {}) {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (error: Error) => { throw error },
    onAbort: () => {},
    onApprovalRequired: async () => false,
    ...overrides,
  }
}

describe('text-only reply persistence (delta-only client)', () => {
  it('persists a text-only reply to session history even without a text content block', async () => {
    const session = new SessionContext()
    // Mimic the real OpenAI-compatible client: text arrives ONLY via onTextDelta.
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onTextDelta('The answer is 4.')
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 10 })
      }),
    } as unknown as StreamClient

    const agent = makeAgent(client, session)
    await agent.run('what is 2+2?', makeCallbacks())

    const messages = session.getMessages()
    assert.equal(messages.length, 2, 'history must contain user + assistant')
    assert.equal(messages[1]!.role, 'assistant')
    assert.equal(messages[1]!.content, 'The answer is 4.')
  })

  it('persists the final text reply after a tool turn (delta-only client)', async () => {
    const session = new SessionContext()
    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock({ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: '/test/package.json' } })
          cb.onStopReason('tool_use', { input_tokens: 150, output_tokens: 80 })
        } else {
          cb.onTextDelta('Found the file.')
          cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
        }
      }),
    } as unknown as StreamClient

    const agent = makeAgent(client, session)
    await agent.run('read package.json', makeCallbacks())

    const messages = session.getMessages()
    const lastMsg = messages[messages.length - 1]!
    assert.equal(lastMsg.role, 'assistant', 'history must end with the final assistant reply')
    assert.equal(lastMsg.content, 'Found the file.')
  })

  it('does not duplicate text when the client emits both delta and text block', async () => {
    const session = new SessionContext()
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onTextDelta('Hello!')
        cb.onContentBlock({ type: 'text', text: 'Hello!' })
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 10 })
      }),
    } as unknown as StreamClient

    const agent = makeAgent(client, session)
    await agent.run('hi', makeCallbacks())

    const messages = session.getMessages()
    assert.equal(messages.length, 2)
    assert.equal(messages[1]!.content, 'Hello!', 'text must not be duplicated in history')
  })
})

describe('maxTurns exhaustion completion', () => {
  it('emits a final onTurnComplete when the turn loop exhausts maxTurns', async () => {
    const session = new SessionContext()
    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        cb.onContentBlock({ type: 'tool_use', id: `tu_${callCount}`, name: 'read_file', input: { file_path: '/test/file.txt' } })
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = makeAgent(client, session, 3)
    const finals: boolean[] = []
    await agent.run('loop until maxTurns', makeCallbacks({
      onTurnComplete: (_usage, _turn, isFinal) => { finals.push(isFinal !== false) },
    }))

    assert.ok(finals.length > 0, 'onTurnComplete must fire')
    assert.equal(finals[finals.length - 1], true,
      'the last onTurnComplete must be final so the TUI state machine resets (agentBusy/isStreaming)')
    assert.ok(finals.slice(0, -1).every(f => f === false), 'intermediate turns must not be final')
  })
})
