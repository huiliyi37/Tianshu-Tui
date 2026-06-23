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

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-phantom-cwd-'))

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

/** Client that emits a different text per call, never a tool call. */
function textSequenceClient(texts: string[]): { client: StreamClient; calls: () => number } {
  let i = 0
  const client = {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      const text = texts[Math.min(i, texts.length - 1)] ?? ''
      i++
      cb.onTextDelta(text)
      cb.onContentBlock({ type: 'text', text })
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 20 })
    }),
  } as unknown as StreamClient
  return { client, calls: () => i }
}

function makeLoop(client: StreamClient, maxAutoContinue: number): { agent: AgentLoop; session: SessionContext } {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  const agent = new AgentLoop(
    {
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 8,
      maxAutoContinue,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    },
    session,
    TEST_CWD,
  )
  return { agent, session }
}

function runCallbacks(finals: boolean[]) {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: (_u: unknown, _t: number, isFinal?: boolean) => { finals.push(isFinal === true) },
    onError: (e: Error) => { throw e },
    onAbort: () => {},
    onApprovalRequired: async () => false,
  }
}

describe('AgentLoop — phantom continuation', () => {
  it('auto-continues one bounded iteration on a no-tool action-intent turn', async () => {
    // Turn 1: action intent, no tool → should auto-continue.
    // Turn 2: plain completion, no intent → should end.
    const { client, calls } = textSequenceClient([
      'Let me run grep to search the code.',
      'I have finished; nothing else to do.',
    ])
    const { agent, session } = makeLoop(client, 1)
    const finals: boolean[] = []
    await agent.run('请帮我在代码里查一下 phantom 的实现', runCallbacks(finals))

    assert.equal(calls(), 2, 'loop should stream twice (one auto-continue)')
    assert.equal(finals.filter(f => f === false).length, 1, 'exactly one intermediate (auto-continue) completion')
    assert.equal(finals.filter(f => f === true).length, 1, 'exactly one final completion')
    assert.equal(session.getTurnCount(), 2)
  })

  it('respects the per-run budget (does not continue past maxAutoContinue)', async () => {
    // Every turn shows action intent, but budget=1 caps it at a single continue.
    const { client, calls } = textSequenceClient([
      'Let me run grep now.',
      'Let me run grep again.',
      'Let me keep grepping.',
    ])
    const { agent } = makeLoop(client, 1)
    const finals: boolean[] = []
    await agent.run('查一下', runCallbacks(finals))

    assert.equal(calls(), 2, 'budget=1 → at most one auto-continue, then stop')
    assert.equal(finals.filter(f => f === true).length, 1)
  })

  it('does not auto-continue when disabled (maxAutoContinue=0)', async () => {
    const { client, calls } = textSequenceClient(['Let me run grep to search the code.'])
    const { agent } = makeLoop(client, 0)
    const finals: boolean[] = []
    await agent.run('查一下', runCallbacks(finals))

    assert.equal(calls(), 1, 'feature disabled → no auto-continue')
    assert.equal(finals.filter(f => f === true).length, 1)
  })
})
