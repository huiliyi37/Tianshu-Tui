/**
 * TTSR (Turn-Time Stream Rule) retry cap test.
 *
 * Verifies the per-run retry governor in TurnOrchestrator:
 * - When a stream rule triggers (e.g. DROP TABLE), the turn is aborted and
 *   a system-reminder is injected, then retried.
 * - After MAX_RULE_RETRIES (2) triggers for the same pattern, the rule is
 *   disabled for the rest of the run.
 * - On the 3rd+ attempt, the disabled rule no longer aborts the stream,
 *   so the turn proceeds normally.
 *
 * Anti-regression: without the cap, a model that keeps emitting the matched
 * command would loop until maxTurns, spamming identical reminders.
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
import { BASH_TOOL } from '../../tools/bash.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-ttsr-cwd-'))

function makeToolUseBlock(id: string, command: string): ContentBlock {
  return { type: 'tool_use', id, name: 'bash', input: { command } }
}

function makeTextBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

/**
 * Mock client that emits a bash tool_use matching DROP TABLE on every call
 * until `disableAfter` calls, then emits a clean text-only turn.
 *
 * The stream rule matching happens inside TurnStreamController — the mock
 * client just delivers the blocks. RuleTriggeredError is thrown by
 * TurnStreamController when it sees the bash command matching the pattern.
 */
function mockClientAlwaysDrop(): StreamClient {
  let callCount = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      callCount++
      // Every call: emit a DROP TABLE bash command
      cb.onTextDelta('Let me run this query.')
      cb.onContentBlock(makeToolUseBlock('call_1', 'psql -c "DROP TABLE users;"'))
      cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    }),
  } as unknown as StreamClient
}

/**
 * Mock client that emits DROP TABLE N times, then a clean text turn.
 */
function mockClientDropThenClean(dropTimes: number): StreamClient {
  let callCount = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      callCount++
      const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      if (callCount <= dropTimes) {
        cb.onTextDelta('Running query...')
        cb.onContentBlock(makeToolUseBlock('call_1', 'psql -c "DROP TABLE users;"'))
        cb.onStopReason('tool_use', usage)
      } else {
        cb.onTextDelta('Done, all clear.')
        cb.onContentBlock(makeTextBlock('Done, all clear.'))
        cb.onStopReason('end_turn', usage)
      }
    }),
  } as unknown as StreamClient
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [BASH_TOOL.definition] },
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
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
  }
}

describe('TTSR retry cap', () => {
  it('disables a stream rule after MAX_RULE_RETRIES (2) triggers, then proceeds', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(BASH_TOOL)

    // Client emits DROP TABLE on calls 1-3, then clean text on call 4+.
    // Turn 1: trigger #1 (inject reminder, retry via continue)
    // Turn 2: trigger #2 (inject reminder, retry via continue)
    // Turn 3: trigger #3 → count(3) > MAX_RULE_RETRIES(2) → disable rule + continue
    //   But the stream already completed with tool_use stop_reason and the rule
    //   was triggered mid-stream. After disabling, the loop `continue`s.
    // Turn 4: rule is now disabled → stream completes normally with text
    const client = mockClientDropThenClean(3)
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 10,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      // Custom rule matching DROP TABLE — overlaps with DEFAULT but distinct pattern
      // to verify our own rule (not the built-in) gets disabled.
      streamRules: [
        { pattern: 'DROP\\s+TABLE\\s+users', inject: 'BLOCKED: Do not drop the users table.' },
      ],
    } as any, session, TEST_CWD)

    let completeCount = 0
    let abortCount = 0
    await agent.run('drop the users table', {
      ...makeCallbacks(),
      onTurnComplete: () => { completeCount++ },
      onAbort: () => { abortCount++ },
    })

    // The run must complete (not abort, not exhaust maxTurns silently).
    assert.equal(abortCount, 0, 'should not abort — rule is disabled after cap')
    assert.ok(completeCount >= 1, 'should emit at least one final turn completion')

    // Verify the DROP TABLE rule was disabled: after the run, the messages
    // should contain at most 2 injected reminders (the cap allows 2 retries).
    const messages = session.getMessages()
    const reminderCount = messages.filter(
      m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('BLOCKED: Do not drop')
    ).length
    assert.ok(reminderCount <= 2, `expected ≤2 reminders, got ${reminderCount}`)
  })

  it('injects a system-reminder (not a bare user message) on rule trigger', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(BASH_TOOL)

    // Trigger once, then clean
    const client = mockClientDropThenClean(1)
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 10,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      streamRules: [
        { pattern: 'DROP\\s+TABLE\\s+users', inject: 'BLOCKED: Do not drop the users table.' },
      ],
    } as any, session, TEST_CWD)

    await agent.run('drop the users table', makeCallbacks())

    const messages = session.getMessages()
    // The injected reminder must be wrapped in <system-reminder> tags
    const reminders = messages.filter(
      m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<system-reminder>')
    )
    assert.ok(reminders.length >= 1, 'should have at least one system-reminder injected')
  })
})
