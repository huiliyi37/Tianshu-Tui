/**
 * T9 steer 队列确认语义测试（问题1 回归）：
 *
 * 契约（对齐 kimi-cli / codex：普通消息在 AI 输出期间只入队，turn 结束后交还用户）：
 *  1. 工具边界（onSteerDrain）不得注入普通排队消息（later 级）——消息保持排队，
 *     等待 run 结束后回填输入框、由用户再次 Enter 确认发送。
 *  2. 工具边界仍注入紧急意图（halt=now / redirect=next）——用户主动喊停/改方向
 *     的 steer 特性保留。
 *  3. run 正常结束（onTurnComplete isFinal → notifyRunSettled）后，队列残留
 *     回填输入框（⏮ 已把 N 条排队消息拉回输入框），steerBuffer 清空。
 *  4. 回填后用户再次按 Enter → 消息作为新 run 提交（onSubmit 收到）。
 *
 * RED 基线：修复前测试 1/3/4 失败（onSteerDrain 无过滤 drain 全部 + 正常结束不回填）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn, stripAnsi } from './_harness.js'

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))

// ── 契约 1: 工具边界不注入普通排队消息 ─────────────────────────

test('工具边界不注入普通排队消息：later 级消息保持排队', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => {})

  // 发起第一个 run → agentBusy = true
  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.busy, true, '前置：agentBusy 应为 true')

  // AI 输出中提交普通消息 → 排队
  app.setInput('note during busy')
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(app.steerBuffer.hasPending(), '前置：消息应在 steer buffer 中排队')

  // 模拟工具边界（agent 回调触发 onSteerDrain）
  const drained = app.callbacks.onSteerDrain?.() ?? null

  // 普通消息不得被注入（保持排队等 run 结束回填）
  assert.equal(drained, null, '普通排队消息不应被格式化为 [User guidance] 注入')
  assert.equal(app.steerBuffer.hasPending(), true, '普通排队消息应留在队列')
})

// ── 契约 2: 紧急意图仍即时注入 ─────────────────────────────────

test('工具边界仍注入紧急意图（halt/redirect 即时 steer 保留）', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => {})

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()

  // 用户喊停 → pushNow（halt 意图，优先级 now）
  app.steerBuffer.pushNow('停')
  assert.ok(app.steerBuffer.hasPending())

  const drained = app.callbacks.onSteerDrain?.() ?? null
  assert.ok(drained !== null, 'halt 应立即注入')
  assert.ok(drained!.includes('停'), '注入文本包含 halt 消息')
  assert.equal(app.steerBuffer.hasPending(), false, 'halt 注入后队列应清空')
})

// ── 契约 3: run 正常结束后队列回填输入框 ───────────────────────

test('run 正常结束后：队列残留回填输入框，steerBuffer 清空', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => {})

  // run A：busy 时排队一条普通消息
  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('note 1')
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(app.steerBuffer.hasPending(), '前置：消息应在 steer buffer 中排队')

  // 结束 run A：isFinal → agentBusy 复位（main.ts 随后在 finally 调 notifyRunSettled）
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 10 }, 1, true)
  await tick()
  assert.equal(app.busy, false, '前置：isFinal 后 agentBusy 应为 false')
  app.notifyRunSettled()
  await tick()

  // 排队消息回填输入框，队列清空
  assert.equal(app.getInputValue(), 'note 1', '排队消息应回填到输入框')
  assert.equal(app.steerBuffer.hasPending(), false, '回填后 steerBuffer 应清空')
  const sb = app.getScrollbackContent()
  assert.ok(sb.includes('拉回输入框'), `scrollback 应有回填提示，实际: ${sb.slice(-200)}`)
})

// ── 契约 4: 回填后再次 Enter 提交 ──────────────────────────────

test('回填后再次 Enter：排队消息作为新 run 提交', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('note 1')
  stdin.dataHandler!('\r')
  await tick()

  // 结束 run A → 回填
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 10 }, 1, true)
  await tick()
  app.notifyRunSettled()
  await tick()
  assert.equal(app.getInputValue(), 'note 1', '前置：回填已完成')

  // 用户再次 Enter
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(runs.length, 2, '回填内容应作为新 run 提交')
  assert.equal(runs[1], 'note 1', '提交内容应为排队消息')
  const sb = app.getScrollbackContent()
  assert.ok(stripAnsi(sb).includes('note 1'), 'scrollback 应包含回填消息气泡')
})
