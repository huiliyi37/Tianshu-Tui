/**
 * W-B3 StreamRenderController 生命周期测试 — 验证 ticker/tick/lastActivityMs/
 * assistantHeaderDone 四个状态字段在 TuiApp 行为路径中正确流转。
 *
 * 覆盖缺口（L3 审查标识）：
 *  1. text delta → phase 切到 streaming，isStreaming=true
 *  2. thinking delta → phase 切到 thinking
 *  3. turn complete → phase 回 idle，isStreaming/isThinking 复位
 *  4. 新 turn submit 后重置 streaming 残留
 *  5. tool use → phase 切到 analyzing
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn, stripAnsi } from './_harness.js'

function makeApp() {
  const out = new MockOut(120, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24, modelName: 'test', contextWindow: 200_000,
  })
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))
const microtask = () => Promise.resolve().then(() => {})

interface AppState {
  state: { phase: string; isStreaming: boolean; isThinking: boolean }
}

test('text delta → streaming 激活', async () => {
  const { app } = makeApp()
  app.callbacks.onTextDelta('hello')
  await tick()
  const s = (app as unknown as AppState).state
  assert.equal(s.isStreaming, true, 'isStreaming 应为 true')
  assert.equal(s.phase, 'streaming', 'phase 应为 streaming')
})

test('thinking delta → thinking 激活', async () => {
  const { app } = makeApp()
  app.callbacks.onThinkingDelta('reasoning')
  await tick()
  const s = (app as unknown as AppState).state
  assert.equal(s.isThinking, true, 'isThinking 应为 true')
  assert.equal(s.phase, 'thinking', 'phase 应为 thinking')
})

test('tool use → analyzing phase', async () => {
  const { app } = makeApp()
  app.callbacks.onToolUse('t1', 'bash', { command: 'ls' })
  await tick()
  const s = (app as unknown as AppState).state
  assert.equal(s.phase, 'analyzing', 'tool use 后 phase 应为 analyzing')
})

test('turn complete → idle 复位 + isStreaming/isThinking 清除', async () => {
  const { app } = makeApp()
  // 先激活 streaming + thinking
  app.callbacks.onThinkingDelta('think')
  app.callbacks.onTextDelta('text')
  await tick()
  const before = (app as unknown as AppState).state
  assert.ok(before.isStreaming || before.isThinking, '前置：至少一个 streaming 标志为 true')

  // turn complete
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, 1, true)
  await tick()
  const after = (app as unknown as AppState).state
  assert.equal(after.phase, 'idle', 'turn complete 后 phase 应回 idle')
  assert.equal(after.isStreaming, false, 'isStreaming 应回 false')
  assert.equal(after.isThinking, false, 'isThinking 应回 false')
})

test('abort → idle 复位 + streaming 残留清除', async () => {
  const { app } = makeApp()
  app.submitText('prompt')
  await tick()
  app.callbacks.onTextDelta('streaming text')
  await tick()
  assert.equal((app as unknown as AppState).state.phase, 'streaming', '前置：phase=streaming')

  app.callbacks.onAbort()
  await tick()
  const s = (app as unknown as AppState).state
  assert.equal(s.phase, 'idle', 'abort 后 phase 应回 idle')
  assert.equal(s.isStreaming, false, 'abort 后 isStreaming 应回 false')
})

test('thinking delta 默认显示推理正文（无需 Ctrl+T 展开）', async () => {
  // 回归守卫：thinkingExpanded 默认 true + 渲染门槛不再要求展开。
  // 若有人把默认改回折叠（如 bug 9755c29a 之前），此测试拦截。
  const { app, out } = makeApp()
  out.clear()
  app.callbacks.onThinkingDelta('推理甲行\n推理乙行')
  await microtask()
  await tick()
  const rendered = stripAnsi(out.chunks.join(''))
  assert.ok(rendered.includes('推理甲行'), `默认应渲染推理正文，实际: ${rendered.slice(0, 200)}`)
})

test('thinking → tool use 时 commit 折叠为「已推理」摘要', async () => {
  // collapse-on-commit：流式期显示全文，提交到 scrollback 只留一行过去式摘要。
  const { app, out } = makeApp()
  const body = Array.from({ length: 12 }, (_, i) => `推理行${i}`).join('\n')
  app.callbacks.onThinkingDelta(body)
  await microtask()
  await tick()
  out.clear()
  app.callbacks.onToolUse('t1', 'grep', { pattern: 'x' })
  await microtask()
  await tick()
  const committed = stripAnsi(out.chunks.join(''))
  assert.ok(committed.includes('已推理'), `commit 应含「已推理」摘要，实际: ${committed.slice(0, 200)}`)
  assert.ok(!committed.includes('推理行5'), 'collapse-on-commit：正文行不写入 scrollback')
})

test('两轮 turn 间 streaming 状态不泄露', async () => {
  const { app } = makeApp()
  // turn 1
  app.submitText('turn 1')
  await tick()
  app.callbacks.onTextDelta('first turn output')
  await tick()
  assert.equal((app as unknown as AppState).state.phase, 'streaming', 'turn 1 streaming')

  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await tick()
  assert.equal((app as unknown as AppState).state.phase, 'idle', 'turn 1 complete')

  // turn 2
  app.submitText('turn 2')
  await tick()
  assert.equal((app as unknown as AppState).state.phase, 'idle', 'turn 2 submit 后仍 idle（等待 agent 响应）')
  assert.equal((app as unknown as AppState).state.isStreaming, false, 'turn 2 开始前 isStreaming 应为 false')
})
