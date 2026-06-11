/**
 * 0B：AgentLoop abort 在工具阶段卡死时可靠 settle。
 *
 * 子代理调查：executeBatch 内单工具 execute 有 withToolTimeout 与 abort 竞速，
 * 但 withToolTimeout **之前**的阻塞 await（审批 / checkpoint / fileHistory）
 * 与 postTool hooks 不在覆盖内。一旦卡在那里，仅靠 240s 心跳看门狗才能解锁，
 * run() 长时间不 settle、_running 不复位 → 会话假死、abort 后无法再发起。
 *
 * 修复：loop.ts 把整个 executeBatch 用 rejectOnAbort 与 abort 信号竞速。
 *
 * 契约（RED→GREEN）：
 *  - 工具需审批、审批回调永挂（模拟卡死）→ agent.abort() → run() 立即 settle、onAbort 触发。
 *  - 中止后再发起的新 run 必须真正执行（证明 _running 已复位）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { Tool, ToolResult } from '../../tools/types.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-abort-tool-'))

// 一个需审批的简单工具：execute 会立即返回，但只要审批闸卡住就到不了 execute。
const APPROVAL_TOOL: Tool = {
  definition: {
    name: 'needs_approval',
    description: 'requires approval',
    input_schema: { type: 'object', properties: {} },
  },
  execute: async (): Promise<ToolResult> => ({ content: 'done' }),
  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [APPROVAL_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function makeAgent(client: StreamClient) {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(APPROVAL_TOOL)
  return new AgentLoop({
    client,
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 5,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    fsWatcherEnabled: false,
  }, session, TEST_CWD)
}

type Cbs = Parameters<AgentLoop['run']>[1]
const cbs = (over: Partial<Cbs> = {}): Cbs => ({
  onTextDelta: () => {},
  onThinkingDelta: () => {},
  onToolUse: () => {},
  onToolResult: () => {},
  onTurnComplete: () => {},
  onError: () => {},
  onAbort: () => {},
  onApprovalRequired: async () => true,
  ...over,
}) as Cbs

const emitToolUse = (cb: StreamCallbacks) => {
  cb.onContentBlock({ type: 'tool_use', id: 't1', name: 'needs_approval', input: {} } as never)
  cb.onStopReason('tool_use', { input_tokens: 5, output_tokens: 5 })
}

describe('AgentLoop — abort settles when stuck in tool-batch approval (0B)', () => {
  it('hung approval → abort frees run() promptly + onAbort fires', async () => {
    const client = {
      stream: async (_r: unknown, cb: StreamCallbacks) => { emitToolUse(cb) },
    } as unknown as StreamClient
    const agent = makeAgent(client)

    let aborted = false
    // 审批回调永不 resolve —— 模拟工具阶段卡死（withToolTimeout 之前的盲区）
    const p = agent.run('do it', cbs({
      onApprovalRequired: () => new Promise<boolean>(() => {}),
      onAbort: () => { aborted = true },
    }))

    // 给 loop 一个 tick 走到 executeBatch 并卡在审批
    await new Promise(r => setTimeout(r, 80))
    agent.abort()

    // run() 必须迅速 settle（loop 级 rejectOnAbort 竞速 executeBatch），否则超时失败
    await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('run() 未在 1s 内 settle —— 工具阶段 abort 仍卡死')), 1000)),
    ])
    assert.equal(aborted, true, 'onAbort 应在中止卡死审批后触发')
  })

  it('中止卡死 run 后，新 run 真正执行（证明 _running 已复位）', async () => {
    let phase: 'hang' | 'normal' = 'hang'
    let secondRan = false
    const client = {
      stream: async (_r: unknown, cb: StreamCallbacks) => {
        if (phase === 'hang') {
          emitToolUse(cb)
        } else {
          secondRan = true
          cb.onTextDelta('ok')
          cb.onContentBlock({ type: 'text', text: 'ok' } as never)
          cb.onStopReason('end_turn', { input_tokens: 3, output_tokens: 2 })
        }
      },
    } as unknown as StreamClient
    const agent = makeAgent(client)

    const p1 = agent.run('hang', cbs({ onApprovalRequired: () => new Promise<boolean>(() => {}) }))
    await new Promise(r => setTimeout(r, 80))
    agent.abort()
    await p1

    phase = 'normal'
    await agent.run('second', cbs())
    assert.equal(secondRan, true, '中止后新 run 应真正执行 stream（_running 已复位）')
  })
})
