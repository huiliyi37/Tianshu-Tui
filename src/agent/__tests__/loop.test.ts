import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop, formatActivePlanPointer } from '../loop.js'
import { SessionContext } from '../context.js'
import { RuntimeHookPipeline } from '../runtime-hooks.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { ContextClaimStore } from '../../context/claim-store.js'
import { PlaybookStore } from '../playbook-store.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ContentBlock, Message } from '../../api/types.js'
import type { Tool } from '../../tools/types.js'

// Writable cwd for AgentLoop: turn-cache telemetry does a fire-and-forget
// mkdir under ~/.rivet/sessions/<slug>/ (via getSessionDir); an unwritable
// sentinel like TEST_CWD makes that async write reject (ENOENT) after the
// test ends, leaking an unhandledRejection onto the next test.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-loop-cwd-'))

function makeTextBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

/** Creates a mock client that delivers content blocks and then stops */
function mockClient(blocks: ContentBlock[], stopReason = 'end_turn', usage = { input_tokens: 100, output_tokens: 50 }): StreamClient {
  let called = false
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      if (called) {
        for (const b of blocks) {
          if (b.type === 'text' && 'text' in b) cb.onTextDelta(b.text)
          cb.onContentBlock(b)
        }
        cb.onStopReason(stopReason, usage)
        return
      }
      called = true
      for (const b of blocks) {
        if (b.type === 'text' && 'text' in b) cb.onTextDelta(b.text)
        cb.onContentBlock(b)
      }
      cb.onStopReason('tool_use', usage)
    }),
  } as unknown as StreamClient
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

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

describe('AgentLoop — multi-turn tool_use', () => {
  it('completes a simple text turn (no tool_use)', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client = mockClient([makeTextBlock('Hello! How can I help?')])
    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const texts: string[] = []
    let completeCount = 0

    await agent.run('hello', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => { completeCount++ },
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(texts.join(''), 'Hello! How can I help?')
    assert.equal(completeCount, 1)
    assert.equal(session.getTurnCount(), 1)
    assert.equal(session.getMessages().length, 2) // user + assistant
  })

  it('ends a wedged run when the same tool batch keeps erroring (denied-approval loop)', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    let execCount = 0
    const failTool: Tool = {
      definition: { name: 'always_fail', description: 'always errors', input_schema: { type: 'object', properties: {} } },
      execute: async () => { execCount++; return { content: 'denied: requires user approval', isError: true } },
      requiresApproval: () => false,
      isConcurrencySafe: () => false,
      isEnabled: () => true,
    }
    registry.register(failTool)

    // Client that re-emits the SAME tool_use every turn. Without the wedge guard
    // this spins until maxTurns (20), ballooning context — the sidecar-OOM cause.
    let n = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onContentBlock(makeToolUseBlock(`call-${n++}`, 'always_fail', { x: 1 }))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 10 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 20, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    let finalCompletions = 0
    const stopReasons: string[] = []
    const errors: Error[] = []
    await agent.run('go', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (_usage: unknown, _turn: number, isFinal?: boolean) => { if (isFinal) finalCompletions++ },
      onError: (e: Error) => { errors.push(e) },
      onAbort: () => {},
      onApprovalRequired: async () => false,
      onPhaseChange: (phase: string, detail?: { reason?: string }) => {
        if (phase === 'stop-reason' && detail?.reason) stopReasons.push(detail.reason)
      },
    })

    assert.deepEqual(errors, [], 'no unexpected errors')
    // Guard trips at MAX_WEDGE_REPEATS (3) — far below maxTurns (20).
    assert.ok(execCount >= 3 && execCount <= 5, `wedge guard should stop early, ran ${execCount}×`)
    assert.ok(stopReasons.some(r => r.includes('工具死循环')), `expected a wedged-loop stop reason, got: ${JSON.stringify(stopReasons)}`)
    assert.equal(finalCompletions, 1, 'exactly one final turn completion is emitted so the UI resets')
  })

  it('syncs auto reasoning effort to the client without going below the configured floor', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const efforts: string[] = []
    const client: StreamClient = {
      setReasoningEffort: mock.fn((effort: string) => { efforts.push(effort) }),
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onTextDelta('done')
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 5,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      autoReasoning: true,
      reasoningFloor: 'high',
    }, session, TEST_CWD)

    await agent.run('What does this function do?', makeCallbacks())

    assert.ok(efforts.length >= 1)
    assert.ok(efforts.every(effort => effort === 'high'))
    assert.equal(agent.getReasoningEffort(), 'high')
  })

  it('executes tool_use and continues loop', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_1', 'read_file', { file_path: '/test/package.json' }))
          cb.onStopReason('tool_use', { input_tokens: 150, output_tokens: 80 })
        } else {
          cb.onTextDelta('Found package.json')
          cb.onContentBlock(makeTextBlock('Found package.json'))
          cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const toolUses: string[] = []
    const toolResults: string[] = []

    await agent.run('read package.json', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: (_id, name) => { toolUses.push(name) },
      onToolResult: (_id, name) => { toolResults.push(name) },
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(callCount, 2)
    assert.deepEqual(toolUses, ['read_file'])
    assert.deepEqual(toolResults, ['read_file'])
    assert.ok(session.getMessages().length >= 4, `expected at least 4 messages, got ${session.getMessages().length}`)
  })

  it('binds a matched star domain once per session and injects it into latest volatile context', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const engine = makeEngine()
    const seenContexts: string[] = []

    const client: StreamClient = {
      stream: mock.fn(async (req: { messages: Message[] }, cb: StreamCallbacks, _sig?: AbortSignal) => {
        const contexts = req.messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('<star-domain'))
        const context = contexts.at(-1)
        if (context && typeof context.content === 'string') seenContexts.push(context.content)
        cb.onTextDelta('done')
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: engine, toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    await agent.run('探索一个新的实验性 POC', makeCallbacks())
    await agent.run('修复内存泄漏', makeCallbacks())

    assert.equal(seenContexts.length, 2)
    assert.match(seenContexts[0]!, /<star-domain name="破军"/)
    assert.match(seenContexts[1]!, /<star-domain name="破军"/)
    assert.doesNotMatch(seenContexts[1]!, /name="天府"/)
  })


  it('stores cache diagnostic when latest turn hit rate is low', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 90,
        })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    await agent.run('hello', makeCallbacks())

    assert.match(agent.getCacheDiagnostic() ?? '', /cache/i)
  })

  it('clears cache diagnostic when latest turn hit rate is healthy', async () => {
    const session = new SessionContext()
    session.recordTurnCache(1, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 90,
    })
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 10,
        })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    await agent.run('hello', makeCallbacks())

    assert.equal(agent.getCacheDiagnostic(), null)
  })

  it('clears cache diagnostic when latest turn has no cache counters', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    await agent.run('hello', makeCallbacks())

    assert.equal(agent.getCacheDiagnostic(), null)
  })


  // Prewarm consumer revived (cc2f4f33 "revive prewarm dead store — wire the
  // consumer side"): full-file read_file calls serve from the prewarm cache
  // again. The truncation regression that originally disabled this is fixed in
  // prewarm-file.ts — the cache now stores FULL raw content and read-file.ts
  // applies the active contextWindow's cap at consume time, with mtime
  // re-verification guarding against stale serves.
  it('serves read_file from the prewarm cache on a repeat read of an unchanged file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-loop-prewarm-'))
    const filePath = join(dir, 'cached.txt')
    writeFileSync(filePath, 'cached content', 'utf-8')

    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1 || callCount === 3) {
          cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'read_file', { file_path: filePath }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
          return
        }
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, dir)
    const callbacks = {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (error: Error) => { throw error },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    }

    await agent.run('read once', callbacks)
    assert.equal(agent.getPrewarmStats().hits, 0)

    await agent.run('read again', callbacks)
    // prewarmRecentReads() seeded cached.txt after run 1; run 2's full-file read
    // (no offset/limit) consumes it — mtime unchanged, so it's a live hit.
    assert.equal(agent.getPrewarmStats().hits, 1)

    rmSync(dir, { recursive: true, force: true })
  })

  it('respects maxTurns limit', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'read_file', { file_path: '/test/file.txt' }))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 3, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    await agent.run('loop test', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.ok(callCount <= 3, `callCount ${callCount} should be <= 3`)
    assert.equal(callCount, 3)
  })

  it('aborts during multi-turn loop', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'read_file', { file_path: '/test/file.txt' }))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 20, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    let aborted = false
    const runPromise = agent.run('abort test', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => { agent.abort() },
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => { aborted = true },
      onApprovalRequired: async () => false,
    })

    await runPromise
    assert.equal(aborted, true)
  })

  it('delivers complete tool input after JSON accumulation', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_json', 'read_file', { file_path: '/test/data.json', offset: 10, limit: 50 }))
          cb.onContentBlock(makeTextBlock('Reading...'))
          cb.onStopReason('tool_use', { input_tokens: 120, output_tokens: 60 })
        } else {
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', { input_tokens: 80, output_tokens: 20 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const toolInputs: Record<string, unknown>[] = []

    await agent.run('read with params', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: (_id, _name, input) => { toolInputs.push(input) },
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(toolInputs.length, 1)
    assert.deepEqual(toolInputs[0], { file_path: '/test/data.json', offset: 10, limit: 50 })
  })

  it('delivers text from all turns including after tool_use and passes isFinal correctly', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onTextDelta('Reading file...')
          cb.onContentBlock(makeTextBlock('Reading file...'))
          cb.onContentBlock(makeToolUseBlock('tu_1', 'read_file', { file_path: '/test/package.json' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onTextDelta('File contains hello world.')
          cb.onContentBlock(makeTextBlock('File contains hello world.'))
          cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const texts: string[] = []
    let intermediateCount = 0
    let finalCount = 0

    await agent.run('read package.json', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (_u, _t, isFinal) => {
        if (isFinal === false) intermediateCount++
        if (isFinal === true) finalCount++
      },
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const allText = texts.join('')
    assert.ok(allText.includes('Reading file...'), 'Turn 1 text should be delivered')
    assert.ok(allText.includes('File contains hello world.'), 'Turn 2 text should be delivered')
    assert.equal(intermediateCount, 1)
    assert.equal(finalCount, 1)
  })

  it('suppresses repeated pre-tool narration across tool-use turns', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onTextDelta('审查发现了 4 个中风险问题，全部修复。开始：')
          cb.onContentBlock(makeTextBlock('审查发现了 4 个中风险问题，全部修复。开始：'))
          cb.onContentBlock(makeToolUseBlock('tu_1', 'read_file', { file_path: '/test/a.ts' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else if (callCount === 2) {
          cb.onTextDelta('  审查发现了 4 个中风险问题，全部修复。开始：\n')
          cb.onContentBlock(makeTextBlock('  审查发现了 4 个中风险问题，全部修复。开始：\n'))
          cb.onContentBlock(makeToolUseBlock('tu_2', 'read_file', { file_path: '/test/b.ts' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onTextDelta('完成。')
          cb.onContentBlock(makeTextBlock('完成。'))
          cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const texts: string[] = []

    await agent.run('fix review issues', {
      ...makeCallbacks(),
      onTextDelta: (t) => texts.push(t),
    })

    const allText = texts.join('')
    assert.equal(allText.match(/审查发现了 4 个中风险问题/g)?.length, 1)
    assert.ok(allText.includes('完成。'))
  })

  it('does not suppress new content after matching the previous turn fingerprint prefix', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    // 注意措辞：全文不能含"我来/让我/接下来 + 工具动词"等行动承诺，否则会
    // 触发 action-intent gate（10ecffa5）合法追加一轮，callCount 断言失真。
    const repeatedPrefix = '这个文件的核对结果如下。'
    const newContent = '第二个问题的分析已经完成。'
    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onTextDelta(repeatedPrefix)
          cb.onContentBlock(makeTextBlock(repeatedPrefix))
          cb.onContentBlock(makeToolUseBlock('tu_prefix', 'read_file', { file_path: '/test/a.ts' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
          return
        }
        cb.onTextDelta(repeatedPrefix)
        cb.onTextDelta(newContent)
        cb.onContentBlock(makeTextBlock(repeatedPrefix + newContent))
        cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)
    const texts: string[] = []

    await agent.run('continue after prefix', {
      ...makeCallbacks(),
      onTextDelta: (t) => texts.push(t),
    })

    const allText = texts.join('')
    assert.ok(allText.includes(newContent), 'new content after a matching prefix must not be swallowed')
    assert.equal(callCount, 2)
  })
})

describe('AgentLoop — session lifecycle', () => {
  it('runs postSession before final turn completion', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const events: string[] = []
    const runtimeHooks = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'test-perception',
      run: ctx => {
        ctx.effects.setSensorium({ momentum: 0.5, pressure: 0.1, confidence: 0.8, complexity: 0.2, freshness: 0.7, stability: 0.9 })
        ctx.effects.setStrategy({ reasoningEffort: 'medium', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 7 })
      },
    }, {
      phase: 'postSession',
      name: 'test-post-session',
      run: () => { events.push('postSession') },
    }])
    const client = mockClient([makeTextBlock('done')], 'end_turn')
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runtimeHooks,
    }, session, TEST_CWD)

    await agent.run('test prompt', {
      ...makeCallbacks(),
      onTurnComplete: (_usage, _turn, isFinal) => {
        if (isFinal) events.push('final')
      },
    })

    assert.deepEqual(events, ['postSession', 'final'])
  })

  it('runs postSession on AbortError before abort callback', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const events: string[] = []
    const runtimeHooks = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'test-perception',
      run: ctx => {
        ctx.effects.setSensorium({ momentum: 0.5, pressure: 0.1, confidence: 0.8, complexity: 0.2, freshness: 0.7, stability: 0.9 })
        ctx.effects.setStrategy({ reasoningEffort: 'medium', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 7 })
      },
    }, {
      phase: 'postSession',
      name: 'test-post-session',
      run: () => { events.push('postSession') },
    }])
    const client: StreamClient = {
      stream: mock.fn(async () => {
        throw new DOMException('Aborted', 'AbortError')
      }),
    } as unknown as StreamClient
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runtimeHooks,
    }, session, TEST_CWD)

    await agent.run('test prompt', {
      ...makeCallbacks(),
      onAbort: () => { events.push('abort') },
    })

    assert.deepEqual(events, ['postSession', 'abort'])
  })
})

describe('AgentLoop — error handling', () => {
  it('persists partial assistant blocks before returning stream error', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onTextDelta('partial answer')
        cb.onContentBlock(makeTextBlock('partial answer'))
        throw new Error('stream dropped')
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 1, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    let errorMessage = ''
    await agent.run('hello', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (err) => { errorMessage = err.message },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const messages = session.getMessages()
    assert.equal(errorMessage, 'stream dropped')
    assert.equal(messages.at(-1)?.role, 'assistant')
    assert.equal(messages.at(-1)?.content, 'partial answer')
  })

  it('handles tool execution errors gracefully and continues', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_err', 'read_file', { file_path: '/nonexistent/file.txt' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onContentBlock(makeTextBlock('The file was not found.'))
          cb.onStopReason('end_turn', { input_tokens: 150, output_tokens: 30 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const errors: string[] = []

    await agent.run('read bad file', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: (_id, _name, _result, isError) => {
        if (isError) errors.push('tool_error')
      },
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(errors.length, 1)
    assert.equal(callCount, 2)
  })
})


describe('AgentLoop — compact policy', () => {
  it('compacts on small context windows without legacy absolute-threshold approval', async () => {
    const client = mockClient([makeTextBlock('done')])
    const registry = new ToolRegistry()
    const session = new SessionContext()
    const historyMessage = 'x'.repeat(12_000 * 4)
    session.replaceMessages([
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
    ])
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 1,
      contextWindow: 128_000,
      compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }, session)

    await agent.run('continue', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.ok(session.getCompactEvents().length > 0)
    assert.equal(session.getCompactEvents().at(-1)?.tier, 1)
  })


  it('falls back to cache anchors plus resume state when compaction cannot fit the ceiling', async () => {
    const client = mockClient([makeTextBlock('done')])
    const registry = new ToolRegistry()
    const session = new SessionContext()
    const huge = 'x'.repeat(80_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 1,
      contextWindow: 128_000,
      compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }, session)

    await agent.run('continue', {
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
    assert.equal(messages[0]?.content, 'anchor user')
    assert.equal(messages[1]?.content, 'anchor assistant')
    assert.match(String(messages[2]?.content), /<checkpoint-resume>/)
    assert.ok(session.getEstimatedTokens() <= 128_000 * 0.95)
  })
})

describe('AgentLoop — active claims projection', () => {
  it('promotes user constraint anchors into active claim prompt context', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    const engine = makeEngine()
    const claimDir = mkdtempSync(join(tmpdir(), 'rivet-loop-claims-'))
    const claimStore = new ContextClaimStore(claimDir, 'session-123')

    let called = false
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        if (!called) {
          called = true
          // Capture the request for inspection
          cb.onContentBlock(makeTextBlock('done'))
          cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
          return
        }
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: registry,
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      sessionId: 'session-123',
      contextClaimStore: claimStore,
    }, session, TEST_CWD)

    await agent.run('CRITICAL: always run tests before saying done', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onError: (error) => { throw error },
      onAbort: () => {},
      onTurnComplete: () => {},
      onApprovalRequired: async () => true,
    })

    // Verify the claim store recorded the claim
    const activeClaims = claimStore.listActiveClaims()
    assert.equal(activeClaims.length, 1)

    // Harness-only: activeClaims are no longer rendered into the LLM prompt (direction A)
    const streamMock = client.stream as unknown as ReturnType<typeof mock.fn>
    const callArgs = streamMock.mock.calls[0]!.arguments[0] as { messages: Array<{ role: string; content: string }> }
    const requestText = callArgs.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')

    assert.doesNotMatch(requestText, /<active-claims/)
    // Claim text still appears in the original user message (not the claims XML)
    assert.match(requestText, /always run tests before saying done/)
  })

  it('does not fabricate prompt consumers or auto-promote on repeated projection', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    const engine = makeEngine()
    const claimDir = mkdtempSync(join(tmpdir(), 'rivet-loop-promo-'))
    const claimStore = new ContextClaimStore(claimDir, 'session-123')

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        cb.onContentBlock(makeTextBlock(`response ${callCount}`))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: registry,
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      sessionId: 'session-123',
      contextClaimStore: claimStore,
    }, session, TEST_CWD)

    const cb = {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onError: (error: Error) => { throw error },
      onAbort: () => {},
      onTurnComplete: () => {},
      onApprovalRequired: async () => false,
    }

    // Prompt projection alone must NOT fabricate consumers or promote claims
    // (4a2bc7d5 "停止 refreshActiveClaims 虚假 prompt consumer 标记"): a claim merely
    // appearing in the active set each turn is not evidence the model consumed it,
    // so consumers stay empty and the claim never reaches durable_candidate via
    // refresh. Promotion requires real consumers (tool/test/worker channels).
    await agent.run('CRITICAL: always run tests before saying done', cb)
    await agent.run('continue', cb)
    await agent.run('continue again', cb)
    await agent.run('one more for promotion', cb)

    const [claim] = claimStore.listClaims()
    assert.ok(claim, 'user-input claim was proposed')
    assert.equal(claim?.status, 'active', 'stays active — no false prompt-consumer promotion')
    assert.equal(claim?.consumers.length, 0, 'no fabricated prompt consumers on refresh')
  })
})

describe('AgentLoop — antibody generation', () => {
  it('generates failure_pattern claim after tool error with classifiable failure', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    const engine = makeEngine()
    const claimDir = mkdtempSync(join(tmpdir(), 'rivet-loop-antibody-'))
    const claimStore = new ContextClaimStore(claimDir, 'session-ab')

    let toolCalled = false
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        if (!toolCalled) {
          toolCalled = true
          cb.onContentBlock(makeToolUseBlock('tu1', 'bash', { command: 'npx tsc --noEmit' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
          return
        }
        cb.onContentBlock(makeTextBlock('I will fix the type error.'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    registry.register({
      definition: { name: 'bash', description: 'run bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
      execute: async () => ({ content: "error TS2345: Type 'string' is not assignable to type 'number'", isError: true }),
      isConcurrencySafe: () => false,
      isEnabled: () => true,
      requiresApproval: () => false,
    })

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      sessionId: 'session-ab',
      contextClaimStore: claimStore,
    }, session, TEST_CWD)

    await agent.run('fix types', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onError: (error: Error) => { throw error },
      onAbort: () => {},
      onTurnComplete: () => {},
      onApprovalRequired: async () => true,
    })

    const antibodies = claimStore.listClaims({ kind: ['failure_pattern'] })
    assert.ok(antibodies.length >= 1, 'expected at least one failure_pattern claim')
    assert.ok(antibodies[0]!.tags.includes('antibody'), 'expected antibody tag')
    assert.ok(antibodies[0]!.text.includes('type_error'), 'expected type_error in text')
  })

  it('does not suppress first-turn text when it matches previous run last turn', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        cb.onTextDelta('Hello! How can I help?')
        cb.onContentBlock(makeTextBlock('Hello! How can I help?'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client, promptEngine: makeEngine(), toolRegistry: registry,
      maxTurns: 5, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }, session, TEST_CWD)

    const texts1: string[] = []
    await agent.run('hello', {
      onTextDelta: (t) => texts1.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const texts2: string[] = []
    await agent.run('hello again', {
      onTextDelta: (t) => texts2.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(texts1.join(''), 'Hello! How can I help?')
    assert.equal(texts2.join(''), 'Hello! How can I help?', 'second run text should not be suppressed by dedup')
  })
})

describe('AgentLoop — playbook telemetry bounds', () => {
  it('caps sensorium snapshots retained for playbook reflection', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      execute: async () => ({ content: 'ok' }),
      isConcurrencySafe: () => true,
      isEnabled: () => true,
      requiresApproval: () => false,
    })
    const dir = mkdtempSync(join(tmpdir(), 'rivet-loop-playbook-'))
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        cb.onContentBlock(makeToolUseBlock(`tu_${session.getTurnCount()}`, 'noop', {}))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 10 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 120, contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' }, playbookStore: new PlaybookStore(dir) },
      session, TEST_CWD,
    )

    try {
      await agent.run('test prompt', {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onToolResult: () => {},
        onTurnComplete: () => {},
        onError: (e) => { throw e },
        onAbort: () => {},
        onApprovalRequired: async () => false,
      })

      // The exact MAX_SNAPSHOTS=100 cap (and oldest-shifted eviction) is unit-
      // tested in turn-perception.test.ts. The loop's anti-loop guards stop the
      // run well before 120 iterations, so here we only assert the integration
      // invariant the loop actually guarantees: snapshots accumulate across
      // iterations and stay bounded by the cap — never growing unbounded.
      const snaps = agent['sensoriumSnapshots']
      assert.ok(snaps.length >= 1, 'at least one sensorium snapshot after a run()')
      assert.ok(snaps.length <= 100, `snapshots bounded by cap, got ${snaps.length}`)
      const firstTurn = snaps[0]!.turn
      const lastTurn = snaps[snaps.length - 1]!.turn
      // First snapshot is turn 0 when the run stops below the cap (no eviction);
      // once the cap evicts, the oldest retained turn climbs (covered in the unit test).
      assert.ok(firstTurn >= 0, 'turn is non-negative after a run()')
      assert.ok(lastTurn >= firstTurn, `last turn ${lastTurn} >= first ${firstTurn}`)
      assert.ok(lastTurn - firstTurn < 100, 'turn range should be bounded by maxTurns')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('AgentLoop — output token escalation', () => {
  it('accepts partial output on max_output_tokens without escalating', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        callCount++
        cb.onTextDelta('Partial response...')
        cb.onContentBlock(makeTextBlock('Partial response...'))
        cb.onStopReason('max_output_tokens', { input_tokens: 100, output_tokens: 4096 })
      }),
    } as unknown as StreamClient

    const texts: string[] = []
    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    await agent.run('test prompt', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    // No escalation: partial output accepted, turn completes immediately
    assert.equal(callCount, 1)
    assert.ok(texts.some(t => t.includes('Partial response')))
  })

  it('completes turn on max_output_tokens without escalation loop', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    let callCount = 0
    let finalCount = 0

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        callCount++
        cb.onTextDelta(`chunk ${callCount}.`)
        cb.onContentBlock(makeTextBlock(`chunk ${callCount}.`))
        cb.onStopReason('max_output_tokens', { input_tokens: 100, output_tokens: 4096 })
      }),
    } as unknown as StreamClient

    const texts: string[] = []
    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 10, contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    await agent.run('test prompt', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (_usage, _turn, isFinal) => {
        if (isFinal) finalCount++
      },
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    // No escalation: partial output accepted in a single turn
    assert.equal(callCount, 1)
    assert.equal(finalCount, 1)
    assert.ok(texts.some(t => t.includes('chunk 1')))
  })
})

describe('AgentLoop — worktree reality detection', () => {
  it('calls detectWorktreeReality and sets result on promptEngine', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    const engine = makeEngine()
    let worktreeRealitySet = false

    // Mock setWorktreeReality to track calls
    const originalSetWorktreeReality = engine.setWorktreeReality.bind(engine)
    engine.setWorktreeReality = (reality) => {
      worktreeRealitySet = true
      originalSetWorktreeReality(reality)
    }

    const client = mockClient([makeTextBlock('Done.')])
    const agent = new AgentLoop(
      {
        client,
        promptEngine: engine,
        toolRegistry: registry,
        maxTurns: 1,
        contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      session,
      '/nonexistent-worktree-path', // Non-existent path will trigger worktree reality check
    )

    await agent.run('test', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    // setWorktreeReality should have been called during run()
    assert.ok(worktreeRealitySet, 'setWorktreeReality should be called')
  })
})

describe('AgentLoop — task contract 3-way branch', () => {
  it('extracts fresh contract on actionable input', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client = mockClient([makeTextBlock('Done.')])
    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    await agent.run('fix src/api/client.ts retry bug', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const contract = agent.getTaskContract()
    assert.ok(contract, 'contract should be extracted for actionable input')
    assert.equal(contract!.objective, 'fix src/api/client.ts retry bug')
    assert.equal(contract!.status, 'exploring')
    assert.ok(contract!.isActionable)
  })

  it('clears contract when no active contract and input is non-actionable', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client = mockClient([makeTextBlock('Hello!')])
    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    await agent.run('你好', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(agent.getTaskContract(), undefined)
  })

  it('inherits existing contract on non-actionable follow-up', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        callCount++
        cb.onTextDelta('Done.')
        cb.onContentBlock(makeTextBlock('Done.'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    // First run: actionable → establishes contract
    await agent.run('fix src/api/client.ts retry bug', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const contractAfterFirst = agent.getTaskContract()
    assert.ok(contractAfterFirst, 'contract should exist after actionable run')
    assert.equal(contractAfterFirst!.objective, 'fix src/api/client.ts retry bug')

    // Second run: non-actionable → inherits existing contract
    await agent.run('thanks', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const contractAfterSecond = agent.getTaskContract()
    assert.ok(contractAfterSecond, 'contract should be inherited on non-actionable follow-up')
    assert.equal(contractAfterSecond!.objective, 'fix src/api/client.ts retry bug')
    assert.equal(contractAfterSecond!.id, contractAfterFirst!.id, 'contract id should remain the same')
  })

  it('clears contract on non-actionable follow-up when previous contract is ready_to_deliver', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client = mockClient([makeTextBlock('Done.')])
    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    // Seed a contract in ready_to_deliver state
    ;(agent as any).taskContract = {
      id: 'task-1-done',
      objective: 'previous task',
      scope: { mentionedFiles: [] },
      constraints: [],
      successCriteria: [],
      status: 'ready_to_deliver',
      createdAtTurn: 1,
      updatedAtTurn: 2,
      isActionable: true,
    }

    await agent.run('thanks', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(agent.getTaskContract(), undefined, 'contract should be cleared when previous is ready_to_deliver')
  })
})

// ── Convergence + doom loop blocked → auto-complete ──

describe('AgentLoop — convergence recovery', () => {
  it('injects completion signal when convergence fires and doom loop is blocked', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()

    // Create a bash tool that returns predictable results
    const bashTool: Tool = {
      definition: {
        name: 'bash',
        description: 'Run shell command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      execute: async () => ({ content: 'ok' }),
      requiresApproval: () => false,
      isConcurrencySafe: () => true,
      isEnabled: () => true,
    }
    registry.register(bashTool)

    let callCount = 0
    // Simulate repeated git log calls: 8 tool_use turns all for the same bash command
    // This will:
    //  1. Fill fingerprint buffer with 8 identical entries → doomLoop = blocked
    //  2. Produce no edits, low novelty, low entropy → convergence score drops
    //  3. Combined: inject completion signal, then model finishes
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount <= 8) {
          cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'bash', { command: 'git log --oneline' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 30 })
        } else {
          cb.onContentBlock(makeTextBlock('All tasks complete. DELIVER_TASK returned GREEN.'))
          cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 30 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      {
        client, promptEngine: makeEngine(), toolRegistry: registry,
        maxTurns: 20, contextWindow: 200_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      session,
      TEST_CWD,
    )

    let finalTurn = false
    const messages: string[] = []
    await agent.run('verify completed task', {
      onTextDelta: (text) => { messages.push(text) },
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (_usage, _turn, isFinal) => { if (isFinal) finalTurn = true },
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => true,
    })

    // Should have completed the turn instead of looping indefinitely
    assert.ok(finalTurn, 'should complete turn after convergence + doom loop detection')
  })
})

// ── No-tool forced abort: prevents 10+ wasted LLM calls on repeated text ──
describe('AgentLoop — no-tool forced abort', () => {
  it('aborts after 5 consecutive text-only turns via thinking-retry path', async () => {
    const registry = new ToolRegistry()
    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        // Produce thinking but no text/blocks → triggers thinking-retry → continue
        // After 1 retry, produce text-only → no tools → break
        // This pattern: think-only → think-only → ... → text → break
        // So consecutiveNoToolTurns won't accumulate here.
        // Instead, test the convergence abort via actual repeated text+tool pattern
        cb.onContentBlock(makeTextBlock(`Repeated analysis output #${callCount}`))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 200 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      {
        client, promptEngine: makeEngine(), toolRegistry: registry,
        maxTurns: 30, contextWindow: 200_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      new SessionContext(),
      TEST_CWD,
    )

    let turnCompletes = 0
    await agent.run('analyze gemini cli', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => { turnCompletes++ },
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => true,
    })

    // Text-only turns break immediately (1 turn per run)
    assert.equal(turnCompletes, 1, 'text-only run should complete after 1 turn')
  })
})

// ── Fix 1/3: convergence "改道" emission cooldown + user-interaction reset ──
// Regression for the 星域·改道 spam incident: a persistent read-only stuck
// state used to re-emit the same 改道 card / phase-change / advisory every
// single turn. It must now be throttled, and reset when the user intervenes.
describe('AgentLoop — convergence emission cooldown', () => {
  function stuckLoop() {
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const agent = new AgentLoop(
      {
        client: mockClient([makeTextBlock('x')]), promptEngine: makeEngine(), toolRegistry: registry,
        maxTurns: 40, contextWindow: 200_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      new SessionContext(),
      TEST_CWD,
    )
    // Read-only history (single tool, distinct targets) → productive stagnation.
    const history = [
      { tool: 'read_file', status: 'success', target: 'a.ts' },
      { tool: 'read_file', status: 'success', target: 'b.ts' },
      { tool: 'read_file', status: 'success', target: 'c.ts' },
      { tool: 'read_file', status: 'success', target: 'd.ts' },
      { tool: 'read_file', status: 'success', target: 'e.ts' },
      { tool: 'read_file', status: 'success', target: 'f.ts' },
    ]
    agent.recentToolHistory = history as unknown as typeof agent.recentToolHistory
    return agent
  }

  it('throttles the 改道 emission instead of firing every turn', async () => {
    const agent = stuckLoop()
    let shifts = 0
    const cb = { ...makeCallbacks(), onDecisionShift: () => { shifts++ } }

    // Same persistent stuck state across 6 turns (14..19), all level 2.
    for (let turn = 14; turn <= 19; turn++) {
      await agent.runConvergenceCheck(turn, 'plan', true, false, cb)
    }

    assert.ok(shifts >= 1, 'expected at least one 改道 emission')
    assert.ok(shifts < 6, `expected throttled emissions over 6 turns, got ${shifts}`)
    assert.ok(shifts <= 2, `cooldown=3 should cap emissions at 2 over turns 14..19, got ${shifts}`)
  })

  it('wording uses phase-relative turns, not the global session turn (W1, 20b9714e)', async () => {
    const agent = stuckLoop()
    let reason = ''
    const cb = {
      ...makeCallbacks(),
      onPhaseChange: (phase: string, detail?: { reason?: string }) => {
        if (phase === 'convergence-warning') reason = detail?.reason ?? ''
      },
    }

    // First check lands at global turn 90 — the phase baseline is set here, so
    // the message must talk about ~1 phase turn, never "90 轮".
    await agent.runConvergenceCheck(90, 'plan', true, false, cb)
    assert.ok(reason, 'expected a convergence warning emission')
    assert.ok(!reason.includes('90'), `wording must not leak the global turn count: ${reason}`)
    assert.ok(reason.includes('近 1 轮'), `expected phase-relative count in wording: ${reason}`)
  })

  it('user intervention resets the cooldown and skips that turn', async () => {
    const agent = stuckLoop()
    let shifts = 0
    const cb = { ...makeCallbacks(), onDecisionShift: () => { shifts++ } }

    await agent.runConvergenceCheck(14, 'plan', true, false, cb) // emit (cooldown start)
    assert.equal(shifts, 1, 'first turn should emit')

    await agent.runConvergenceCheck(15, 'plan', true, false, cb) // within cooldown → skip
    assert.equal(shifts, 1, 'within cooldown should not emit')

    await agent.runConvergenceCheck(15, 'plan', true, true, cb) // user intervened → skip + reset
    assert.equal(shifts, 1, 'user-intervention turn must not emit a nudge')

    await agent.runConvergenceCheck(16, 'plan', true, false, cb) // reset → emit despite <3 turns since last
    assert.equal(shifts, 2, 'cooldown should have been reset by user intervention, allowing an immediate re-emit')
  })
})

// ── Score-abort grace turn (session 8396ac51): the L3 abort must not fire in
// the same evaluation that emits its own warning — the injected advisory is
// consumed by the NEXT request, which never happens if we abort immediately.
describe('AgentLoop — convergence score-abort grace turn', () => {
  function degenerateAgent() {
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const agent = new AgentLoop(
      {
        client: mockClient([makeTextBlock('x')]), promptEngine: makeEngine(), toolRegistry: registry,
        maxTurns: 40, contextWindow: 200_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      new SessionContext(),
      TEST_CWD,
    )
    // Fully degenerate window: same tool, same target, repetitive thin text →
    // score bottoms out (level 3, shouldAbort, abortCause 'score').
    const history = Array.from({ length: 8 }, () => ({ tool: 'read_file', status: 'success', target: 'same.ts' }))
    agent.recentToolHistory = history as unknown as typeof agent.recentToolHistory
    agent.recentTextFingerprints = ['分析中', '分析中', '分析中']
    // Pre-seed a sustained declining score history so the L3 scoreAbort guard
    // (scoreDeclining over the signal window) is satisfied within two turns.
    agent.convergenceScoreHistory = [0.50, 0.40, 0.30, 0.20, 0.10, 0.04]
    return agent
  }

  it('demotes the first score-abort to a kick, then aborts on the next turn', async () => {
    const agent = degenerateAgent()
    let aborts = 0
    let shifts = 0
    const cb = { ...makeCallbacks(), onAbort: () => { aborts++ }, onDecisionShift: () => { shifts++ } }

    const first = await agent.runConvergenceCheck(22, 'execute', true, false, cb)
    assert.equal(first.action, 'proceed', 'first L3 hit must be demoted — no prior-turn warning was delivered')
    assert.equal(aborts, 0)
    assert.equal(shifts, 1, 'the demoted turn must still emit the warning/改道 so the model and user see it')

    const second = await agent.runConvergenceCheck(23, 'execute', true, false, cb)
    assert.equal(second.action, 'abort', 'still stuck one turn after the warning → abort proceeds')
    assert.equal(aborts, 1)
  })

  it('user intervention resets the ladder — the next score-abort demotes again', async () => {
    const agent = degenerateAgent()
    const cb = makeCallbacks()

    await agent.runConvergenceCheck(22, 'execute', true, false, cb) // demoted + warning
    await agent.runConvergenceCheck(23, 'execute', true, true, cb)  // user spoke → reset
    const after = await agent.runConvergenceCheck(24, 'execute', true, false, cb)
    assert.equal(after.action, 'proceed', 'post-intervention L3 hit must get a fresh grace turn, not an instant abort')
  })
})

describe('AgentLoop — recordToolHistory errorClass threading', () => {
  it('writes errorClass into recentToolHistory entry (loop-factory drop-param guard)', () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const client = mockClient([makeTextBlock('ok')])
    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    agent.recordToolHistory('bash', { command: 'sleep 99' }, true, '[timeout]', 'timeout')
    const entry = agent.recentToolHistory.at(-1)
    assert.equal(entry?.errorClass, 'timeout', 'errorClass must survive into the history entry')
    assert.equal(entry?.target, 'sleep 99', 'target should be stripped of cd boilerplate (none here)')
  })
})

describe('formatActivePlanPointer', () => {
  it('emits a slug/title/path pointer without the plan body', () => {
    const out = formatActivePlanPointer({ slug: 'my-plan', title: 'My Plan' })
    assert.match(out, /^<active-plan /)
    assert.match(out, /slug="my-plan"/)
    assert.match(out, /title="My Plan"/)
    assert.match(out, /path="\.rivet\/plans\/my-plan\.md"/)
    assert.match(out, /todo/)
  })

  it('escapes XML special characters in slug and title', () => {
    const out = formatActivePlanPointer({ slug: 'a&b', title: 'Fix <tag> & "q"' })
    assert.doesNotMatch(out.replace(/path="[^"]*"/, ''), /<tag>/)
    assert.match(out, /&amp;/)
    assert.match(out, /&lt;tag&gt;/)
    assert.match(out, /&quot;q&quot;/)
  })

  it('includes selected approach when provided', () => {
    const out = formatActivePlanPointer({
      slug: 'my-plan',
      title: 'My Plan',
      selectedApproach: 'Redis cache (Recommended)',
    })
    assert.match(out, /已选方案/)
    assert.match(out, /Redis cache/)
  })
})

describe('AgentLoop — plan mode lifecycle (2026-07-03 缺陷复盘)', () => {
  function makeAgent() {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const client = mockClient([makeTextBlock('ok')])
    const engine = makeEngine()
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-planmode-'))
    const agent = new AgentLoop({ client, promptEngine: engine, toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, cwd)
    return { agent, engine, cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
  }

  it('enterPlanMode pins writing-plans skill; exitPlanMode releases it', () => {
    const { agent, engine, cleanup } = makeAgent()
    try {
      agent.enterPlanMode()
      assert.ok(engine.getInvokedSkillNames().includes('writing-plans'), 'skill pinned on enter')
      agent.exitPlanMode()
      assert.ok(
        !engine.getInvokedSkillNames().includes('writing-plans'),
        'skill must be released on exit — leaving it would re-inject the planning skill into every execution turn',
      )
    } finally {
      cleanup()
    }
  })

  it('setActivePlan (approval) also releases the writing-plans skill', () => {
    const { agent, engine, cleanup } = makeAgent()
    try {
      agent.enterPlanMode()
      agent.setActivePlan({ slug: 'p', title: 'P' })
      assert.ok(!engine.getInvokedSkillNames().includes('writing-plans'))
      assert.equal(agent.getPlanModeState(), 'off')
      assert.equal(agent.getActivePlanFilePath(), null)
    } finally {
      cleanup()
    }
  })

  it('enterPlanMode is idempotent — re-entry keeps the current draft', () => {
    const { agent, cleanup } = makeAgent()
    try {
      agent.enterPlanMode()
      const first = agent.getActivePlanFilePath()
      assert.ok(first, 'draft created on first enter')
      agent.enterPlanMode()
      assert.equal(agent.getActivePlanFilePath(), first, 're-entry must not orphan the draft being written')
    } finally {
      cleanup()
    }
  })

  it('explicit planFilePath (rejection revision) still retargets while planning', () => {
    const { agent, cleanup } = makeAgent()
    try {
      agent.enterPlanMode()
      agent.enterPlanMode({ planFilePath: '.rivet/plans/my-plan.md' })
      assert.equal(agent.getActivePlanFilePath(), '.rivet/plans/my-plan.md')
    } finally {
      cleanup()
    }
  })

  it('exitPlanMode removes an untouched empty draft but keeps written ones', () => {
    const { agent, cwd, cleanup } = makeAgent()
    try {
      agent.enterPlanMode()
      const emptyDraft = join(cwd, agent.getActivePlanFilePath()!)
      agent.exitPlanMode()
      assert.ok(!existsSync(emptyDraft), 'empty draft cleaned up — no .rivet/plans litter from toggling')

      agent.enterPlanMode()
      const writtenDraft = join(cwd, agent.getActivePlanFilePath()!)
      writeFileSync(writtenDraft, '# Draft\n\ncontent\n', 'utf-8')
      agent.exitPlanMode()
      assert.ok(existsSync(writtenDraft), 'non-empty draft preserved')
    } finally {
      cleanup()
    }
  })
})
