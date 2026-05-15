import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { ApiClient, StreamCallbacks } from '../../api/client.js'
import type { ContentBlock } from '../../api/types.js'

function makeTextBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

/** Creates a mock client that delivers content blocks and then stops */
function mockClient(blocks: ContentBlock[], stopReason = 'end_turn', usage = { input_tokens: 100, output_tokens: 50 }): ApiClient {
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
  } as unknown as ApiClient
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { cwd: '/test', tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: '/test' },
  })
}

describe('AgentLoop — multi-turn tool_use', () => {
  it('completes a simple text turn (no tool_use)', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client = mockClient([makeTextBlock('Hello! How can I help?')])
    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, '/test')

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

  it('executes tool_use and continues loop', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: ApiClient = {
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
    } as unknown as ApiClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, '/test')

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
    assert.equal(session.getMessages().length, 4)
  })

  it('respects maxTurns limit', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: ApiClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'read_file', { file_path: '/test/file.txt' }))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as ApiClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 3, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, '/test')

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
    const client: ApiClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'read_file', { file_path: '/test/file.txt' }))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as ApiClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 20, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, '/test')

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
    const client: ApiClient = {
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
    } as unknown as ApiClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, '/test')

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
})

describe('AgentLoop — error handling', () => {
  it('handles tool execution errors gracefully and continues', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: ApiClient = {
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
    } as unknown as ApiClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, '/test')

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
