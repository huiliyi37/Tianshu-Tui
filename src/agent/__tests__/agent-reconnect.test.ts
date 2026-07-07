/**
 * 2D：客户端重试耗尽后的 agent 层有界重连（默认关）。
 *
 * 契约（RED→GREEN）：
 * - 默认（未配置 agentReconnect）：stream 抛 shouldReconnect 错误 → 不重连，
 *   onError 触发、stream 只被调用一次。
 * - 开启（agentReconnect.enabled=true, maxAttempts=2）：前若干次 stream 抛
 *   shouldReconnect 错误、随后成功 → agent 用相同 request 重连直至成功，
 *   不触发 onError，stream 被多次调用。
 *
 * 旧实现无重连分支 → 开启用例下 stream 仍只调一次、onError 触发 → 失败。
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

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-reconnect-'))

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

/** Client that throws `failCount` times then streams a successful text turn. */
function makeFlakyClient(failCount: number): StreamClient {
  let calls = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      calls++
      if (calls <= failCount) throw reconnectError()
      cb.onTextDelta('recovered')
      cb.onContentBlock({ type: 'text', text: 'recovered' })
      cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
    }),
  } as unknown as StreamClient
}

describe('AgentLoop agent-layer bounded reconnect (2D)', () => {
  it('默认关闭：shouldReconnect 错误不重连，onError 触发、stream 只调一次', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const client = makeFlakyClient(1)

    const agent = new AgentLoop({
      client, promptEngine: makeEngine(), toolRegistry: registry,
      maxTurns: 1, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }, session, TEST_CWD)

    let errored: Error | null = null
    let completed = false
    await agent.run('hi', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => { completed = true },
      onError: (e) => { errored = e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const streamMock = client.stream as unknown as ReturnType<typeof mock.fn>
    assert.equal(streamMock.mock.calls.length, 1, '默认关闭应只调用 stream 一次')
    assert.ok(errored, '默认关闭应把错误透传给 onError')
    assert.equal(completed, false, '错误退出不应正常 complete')
  })

  it('开启：前一次失败后用相同 request 重连成功，不触发 onError', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const client = makeFlakyClient(1) // 第 1 次抛 503，第 2 次成功

    const agent = new AgentLoop({
      client, promptEngine: makeEngine(), toolRegistry: registry,
      maxTurns: 1, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      agentReconnect: { enabled: true, maxAttempts: 2, backoffMs: 1 },
    }, session, TEST_CWD)

    let errored: Error | null = null
    let completed = false
    const texts: string[] = []
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

    const streamMock = client.stream as unknown as ReturnType<typeof mock.fn>
    assert.equal(streamMock.mock.calls.length, 2, '应重连一次（共调用 stream 两次）')
    assert.equal(errored, null, '重连成功后不应触发 onError')
    assert.equal(completed, true, '重连成功后应正常 complete')
    assert.ok(texts.includes('recovered'), '应收到重连后的成功内容')

    // 守护 prefix cache：两次 stream 的 request 必须是同一份消息历史
    const req1 = streamMock.mock.calls[0]!.arguments[0] as { messages: unknown[] }
    const req2 = streamMock.mock.calls[1]!.arguments[0] as { messages: unknown[] }
    assert.deepEqual(req2.messages, req1.messages, '重连必须用相同 request（守护 prefix cache）')
  })

  it('开启但超出 maxAttempts：持续失败最终透传 onError', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const client = makeFlakyClient(99) // 永远失败

    const agent = new AgentLoop({
      client, promptEngine: makeEngine(), toolRegistry: registry,
      maxTurns: 1, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      agentReconnect: { enabled: true, maxAttempts: 2, backoffMs: 1 },
    }, session, TEST_CWD)

    let errored: Error | null = null
    await agent.run('hi', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { errored = e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const streamMock = client.stream as unknown as ReturnType<typeof mock.fn>
    // 首次 + maxAttempts(2) 重连 = 3 次
    assert.equal(streamMock.mock.calls.length, 3, '首次 + 2 次重连 = 3 次调用')
    assert.ok(errored, '重连耗尽后应透传 onError')
  })
})
