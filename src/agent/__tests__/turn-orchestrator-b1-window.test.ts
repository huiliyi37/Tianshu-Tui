/**
 * B1 连续只读螺旋提醒的窗口感知阈值（2026-08：1M 窗口下固定 4 轮太紧）。
 *
 * 触发语义：连续全只读轮（read_file/grep/glob 等）达到窗口阈值（200K→4，
 * 1M→9，线性插值）→ 注入一次性 readonly-spiral 提醒。200K 行为与旧版逐字一致。
 *
 * 集成测试：构造真实 AgentLoop + mock client 连续输出 read_file 工具调用，
 * 驱动 consecutiveReadOnlyTurns 越过阈值，检查注入的 system-reminder。
 */
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { BASH_TOOL } from '../../tools/bash.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'b1-window-test-'))
writeFileSync(join(TEST_CWD, 'evidence.txt'), 'verified\n')

function makeReadFileBlock(id: string, filePath: string): ContentBlock {
  return {
    type: 'tool_use',
    id,
    name: 'read_file',
    input: { file_path: filePath },
  } as ContentBlock
}

function makeTextBlock(text: string): ContentBlock {
  return { type: 'text', text } as ContentBlock
}

/** Mock client: 前 N 次调用输出只读 read_file 工具调用，之后 clean 结束。 */
function mockClientReadOnly(probeTimes: number): StreamClient {
  let callCount = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      callCount++
      const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      if (callCount <= probeTimes) {
        cb.onTextDelta('Gathering evidence...')
        cb.onContentBlock(makeReadFileBlock(`call_${callCount}`, join(TEST_CWD, 'evidence.txt')))
        cb.onStopReason('tool_use', usage)
      } else {
        cb.onTextDelta('Done.')
        cb.onContentBlock(makeTextBlock('Done.'))
        cb.onStopReason('end_turn', usage)
      }
    }),
  } as unknown as StreamClient
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [BASH_TOOL.definition, READ_FILE_TOOL.definition] },
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

function remindersIn(session: SessionContext): string[] {
  return session.getMessages()
    .filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<system-reminder>'))
    .map(m => m.content as string)
}

function makeAgent(client: StreamClient, contextWindow: number): AgentLoop {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(BASH_TOOL)
  registry.register(READ_FILE_TOOL)
  const agent = new AgentLoop({
    client,
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 30,
    contextWindow,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  } as any, session, TEST_CWD)
  return agent
}

describe('B1 readonly-spiral 窗口感知阈值', () => {
  it('1M 窗口：8 轮连续只读不触发（阈值 9）', async () => {
    const agent = makeAgent(mockClientReadOnly(8), 1_000_000)
    await agent.run('read around', makeCallbacks())
    const reminders = remindersIn(agent.session)
    const spiral = reminders.filter(r => r.includes('只读操作'))
    assert.equal(spiral.length, 0, '1M 窗口 8 轮只读不得触发 B1')
  })

  it('1M 窗口：9 轮连续只读触发', async () => {
    const agent = makeAgent(mockClientReadOnly(9), 1_000_000)
    await agent.run('read around', makeCallbacks())
    const reminders = remindersIn(agent.session)
    const spiral = reminders.filter(r => r.includes('只读操作'))
    assert.equal(spiral.length, 1, '1M 窗口 9 轮只读触发 B1')
    assert.match(spiral[0]!, /连续 9 次只读操作/)
  })

  it('200K 窗口保持 4 轮阈值（回归锚点：小窗口旧行为不变）', async () => {
    const agent = makeAgent(mockClientReadOnly(4), 200_000)
    await agent.run('read around', makeCallbacks())
    const reminders = remindersIn(agent.session)
    const spiral = reminders.filter(r => r.includes('只读操作'))
    assert.equal(spiral.length, 1, '200K 窗口 4 轮只读触发 B1')
    assert.match(spiral[0]!, /连续 4 次只读操作/)
  })

  it('同一 run 内只提醒一次：18 轮连续只读只触发 1 次（修复：清零后重新累积会周期性复触发，实测 58 轮 run 内 9/18/27 三次）', async () => {
    const agent = makeAgent(mockClientReadOnly(18), 1_000_000)
    await agent.run('read around', makeCallbacks())
    const reminders = remindersIn(agent.session)
    const spiral = reminders.filter(r => r.includes('只读操作'))
    assert.equal(spiral.length, 1, '18 轮只读（2×阈值）只能触发一次 B1')
  })
})
