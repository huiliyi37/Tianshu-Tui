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
import { buildRuntimeSnapshot } from '../loop-factory.js'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

/**
 * Reasoning-spiral hook 装配回归（2026-08-05 死代码修复判据）：
 *
 * loop-factory.ts:485 的 `|| undefined` 使 lastTurnHadTools 取值域塌缩为
 * {true, undefined}，false 不可达；reasoning-spiral-hook 双守卫（undefined
 * 早退 + true 早退）把生产链路全部挡死，hook 体从不执行。
 *
 * 本测试钉的是真实映射层：AgentLoop 状态（lastThinkingContent /
 * recentToolHistory）→ buildRuntimeSnapshot → runtimeHooks.runPreTurn。
 * 直接注入 snapshot 字面量（reasoning-spiral-hook.test.ts 的 makeCtx 模式）
 * 会绕过映射层，抓不住这条死代码——判据必须走 buildRuntimeSnapshot。
 *
 * 修改前：空窗口 → `some(success) || undefined` = undefined → hook 早退
 *   → 用例 1 的 advisory 断言红（映射层判据成立）。
 * 修改后：turn 级匹配（上一轮是否有工具调用）→ false 可达 → 用例 1 绿。
 */

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-spiral-wiring-'))

function textOnlyClient(text = 'done'): StreamClient {
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      cb.onTextDelta(text)
      cb.onContentBlock({ type: 'text', text })
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    }),
  } as unknown as StreamClient
}

function makeAgent(): AgentLoop {
  const engine = new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client: textOnlyClient(),
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, TEST_CWD)
}

function preTurn(agent: AgentLoop, extra?: Parameters<typeof buildRuntimeSnapshot>[1]): Promise<void> {
  const snapshot = buildRuntimeSnapshot(agent, extra)
  return agent.runtimeHooks.runPreTurn(createRuntimeHookContext(snapshot, {
    injectUserMessage: () => {},
  }))
}

describe('reasoning-spiral hook wiring (buildRuntimeSnapshot → preTurn)', () => {
  it('长推理 3000+ 字符 + 上轮零工具调用 → advisory 发出（修改前必失败的死代码判据）', async () => {
    const agent = makeAgent()
    agent.lastThinkingContent = 'x'.repeat(3500)
    // 空窗口 = 零工具调用。turn=2（会话进行几轮后）避开 hook 冷却期
    // （lastAdvisoryTurn 初始 -1，COOLDOWN_TURNS=2 会挡掉 turn 0/1）。
    const snapshot = buildRuntimeSnapshot(agent, { turn: 2 })
    assert.equal(snapshot.lastTurnHadTools, false,
      '零工具调用时 lastTurnHadTools 必须是 false——修改前 || undefined 使其为 undefined，hook 早退')

    await preTurn(agent, { turn: 2 })
    assert.ok(agent.advisoryBus.peekPendingKeys().includes('reasoning-spiral'),
      '长推理零工具轮应触发 spiral advisory——不触发说明映射层仍在产出 undefined/true（死代码未修）')
  })

  it('长推理 + 上一轮有工具调用（turn 标记）→ 不触发', async () => {
    const agent = makeAgent()
    agent.session.addUserMessage('task') // turnCount = 1；上一轮 = turn 0
    agent.lastThinkingContent = 'x'.repeat(3500)
    agent.recentToolHistory = [{ tool: 'bash', target: 'tsc', status: 'success', turn: 0 }]

    await preTurn(agent)
    assert.ok(!agent.advisoryBus.peekPendingKeys().includes('reasoning-spiral'),
      '上一轮有工具调用时不应触发——spiral 语义是「长推理且未行动」')
  })

  it('短推理 + 零工具 → 不触发（阈值守卫）', async () => {
    const agent = makeAgent()
    agent.lastThinkingContent = 'short' // 5 chars < SPIRAL_THRESHOLD(3000)

    await preTurn(agent)
    assert.ok(!agent.advisoryBus.peekPendingKeys().includes('reasoning-spiral'))
  })
})
