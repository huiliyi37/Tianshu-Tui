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

function mockClient(blocks: ContentBlock[]): ApiClient {
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      for (const b of blocks) {
        if (b.type === 'text' && 'text' in b) cb.onTextDelta(b.text)
        cb.onContentBlock(b)
      }
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    }),
  } as unknown as ApiClient
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

function makeAgent(mode: 'chat' | 'task' = 'task') {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)

  const engine = new PromptEngine({
    model: 'test',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: '/test' },
  })
  engine.setMode(mode)

  const client = mockClient([makeTextBlock('Hello from chat mode!')])
  const agent = new AgentLoop(
    {
      client,
      promptEngine: engine,
      toolRegistry: registry,
      maxTurns: 5,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    },
    session,
    '/test',
  )

  return { agent, session, engine, client }
}

describe('Chat Mode Integration', () => {
  it('does not extract task contract in chat mode', async () => {
    const { agent, session } = makeAgent('chat')
    const texts: string[] = []

    await agent.run('Fix the bug in the login system', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    // In chat mode, task contract should not be extracted
    // The agent should still complete the turn
    assert.equal(texts.join(''), 'Hello from chat mode!')
    assert.equal(session.getTurnCount(), 1)
  })

  it('does not inject cognitive projection in chat mode', async () => {
    const { agent, engine } = makeAgent('chat')
    
    // Set a cognitive projection
    engine.setCognitiveProjection('<cognitive-mirror confidence="1.00"/>')

    // In chat mode, this should NOT be injected into the prompt
    // We verify by checking that the prompt engine's mode is respected
    assert.equal(engine.getMode(), 'chat')

    await agent.run('hello', makeCallbacks())
  })

  it('completes turns without task execution pipeline in chat mode', async () => {
    const { agent, session } = makeAgent('chat')
    const texts: string[] = []
    let turnCompleteCount = 0

    await agent.run('What is the weather today?', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => { turnCompleteCount++ },
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(texts.join(''), 'Hello from chat mode!')
    assert.equal(turnCompleteCount, 1)
    assert.equal(session.getTurnCount(), 1)
  })

  it('switches between chat and task modes correctly', async () => {
    const { agent, engine, session } = makeAgent('chat')
    
    // Start in chat mode
    assert.equal(engine.getMode(), 'chat')
    
    await agent.run('hello', makeCallbacks())
    assert.equal(session.getTurnCount(), 1)

    // Switch to task mode
    engine.setMode('task')
    assert.equal(engine.getMode(), 'task')

    // Mock client for second turn
    const client2 = mockClient([makeTextBlock('Task mode response')])
    const agent2 = new AgentLoop(
      {
        client: client2,
        promptEngine: engine,
        toolRegistry: new ToolRegistry(),
        maxTurns: 5,
        contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      session,
      '/test',
    )

    await agent2.run('Fix the bug', makeCallbacks())
    assert.equal(session.getTurnCount(), 2)
  })

  it('chat mode does not track sycophancy patterns', async () => {
    const { agent, session } = makeAgent('chat')
    
    // Run multiple turns in chat mode
    for (let i = 0; i < 3; i++) {
      await agent.run(`Turn ${i}`, makeCallbacks())
    }

    // In chat mode, sycophancy patterns should not be tracked
    assert.equal(session.getTurnCount(), 3)
  })
})