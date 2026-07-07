import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Writable cwd: AgentLoop turn-cache telemetry fire-and-forgets a mkdir under
// cwd; an unwritable TEST_CWD sentinel makes that async write reject after the
// test ends, leaking an unhandledRejection onto later tests in the same run.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-loop-cwd-'))
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: TEST_CWD },
    habituationThreshold: 0,
  })
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

function finishText(cb: StreamCallbacks, text = 'done') {
  cb.onTextDelta(text)
  cb.onContentBlock({ type: 'text', text })
  cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 10 })
}

describe('AgentLoop intent retrieval router wiring', () => {
  it('does not inject or call router when disabled', async () => {
    const engine = makeEngine()
    const requests: OaiChatRequest[] = []
    const client: StreamClient = {
      stream: mock.fn(async (request: OaiChatRequest, cb: StreamCallbacks) => {
        requests.push(request)
        finishText(cb)
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: new ToolRegistry(),
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      fsWatcherEnabled: false,
      intentRetrievalRouter: { enabled: false },
    }, new SessionContext(), TEST_CWD)

    await agent.run('fix this failing test', makeCallbacks())

    assert.equal(requests.length, 1)
    const joined = requests[0]!.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n')
    // Match the REAL injected block form (with attributes), not the bare
    // `<intent-retrieval-route>` mention inside the static <rules> prompt — the
    // latter is always present and is documentation, not an injected route.
    assert.doesNotMatch(joined, /<intent-retrieval-route advisory=/)
  })

  it('injects rendered heuristic route for actionable turns without extra model call', async () => {
    const engine = makeEngine()
    const requests: OaiChatRequest[] = []
    const client: StreamClient = {
      stream: mock.fn(async (request: OaiChatRequest, cb: StreamCallbacks) => {
        requests.push(request)
        finishText(cb)
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: new ToolRegistry(),
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      fsWatcherEnabled: false,
      intentRetrievalRouter: { enabled: true, classifier: 'heuristic' },
    }, new SessionContext(), TEST_CWD)

    await agent.run('重试一下这个失败', makeCallbacks())

    assert.equal(requests.length, 1)
    const joined = requests[0]!.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n')
    assert.match(joined, /<intent-retrieval-route advisory="true" scope="current-turn"/)
    assert.match(joined, /bug_fix/)
    assert.match(joined, /source="codebase" priority="must"/)
    assert.match(joined, /source="tests" priority="must"/)
  })

  it('falls back when LLM router throws and still completes the run', async () => {
    const engine = makeEngine()
    const requests: OaiChatRequest[] = []
    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (request: OaiChatRequest, cb: StreamCallbacks) => {
        callCount++
        requests.push(request)
        if (callCount === 1) throw new Error('router unavailable')
        finishText(cb)
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: new ToolRegistry(),
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      fsWatcherEnabled: false,
      intentRetrievalRouter: { enabled: true, classifier: 'llm', timeoutMs: 50 },
    }, new SessionContext(), TEST_CWD)

    await agent.run('token 泄露风险', makeCallbacks())

    assert.equal(requests.length, 2)
    assert.equal(requests[0]!.tool_choice, 'none')
    const joined = requests[1]!.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n')
    assert.match(joined, /<intent-retrieval-route/)
    assert.match(joined, /security_safety/)
    assert.match(joined, /fallback-used="true"/)
  })

  it('injects a cognitive-alignment advisory instead of nothing on low-confidence classification', async () => {
    const engine = makeEngine()
    const requests: OaiChatRequest[] = []
    const client: StreamClient = {
      stream: mock.fn(async (request: OaiChatRequest, cb: StreamCallbacks) => {
        requests.push(request)
        finishText(cb)
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: new ToolRegistry(),
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      fsWatcherEnabled: false,
      intentRetrievalRouter: { enabled: true, classifier: 'heuristic' },
    }, new SessionContext(), TEST_CWD)

    // 无任何已覆盖动词/关键词 → 兜底 new_feature，置信度 0.55 < 0.6
    await agent.run('把那个东西弄得更顺手一些', makeCallbacks())

    assert.equal(requests.length, 1)
    const joined = requests[0]!.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n')
    assert.match(joined, /<intent-retrieval-route advisory="true" scope="current-turn" confidence="low">/)
    assert.match(joined, /意图分类不确定/)
    // 低置信时不注入具体检索方向，避免锚定错误的任务类型
    assert.doesNotMatch(joined, /source="codebase" priority="must"/)
  })

  it('clears current-turn route on non-actionable follow-up', async () => {
    const engine = makeEngine()
    const setRouteCalls: Array<string | null> = []
    const originalSetRoute = engine.setIntentRetrievalRoute.bind(engine)
    engine.setIntentRetrievalRoute = (route: string | null) => {
      setRouteCalls.push(route)
      originalSetRoute(route)
    }

    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        finishText(cb)
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: new ToolRegistry(),
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      fsWatcherEnabled: false,
      intentRetrievalRouter: { enabled: true, classifier: 'heuristic' },
    }, new SessionContext(), TEST_CWD)

    await agent.run('修复这个失败', makeCallbacks())
    await agent.run('你好', makeCallbacks())

    assert.ok(setRouteCalls.some(route => typeof route === 'string' && route.includes('<intent-retrieval-route')))
    assert.equal(setRouteCalls.at(-1), null)
  })
})
