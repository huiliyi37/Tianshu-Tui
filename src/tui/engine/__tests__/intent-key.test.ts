/**
 * T9 意图闸（intent preview）按键测试。
 *
 * Bug：T9 路径 onIntentPreview 永远返回 'continue'，等于旁路了
 * 「先确认再动手」的安全闸——agent 启用 intent 预览时 UI 永远放行，无 y/n/veto。
 *
 * 契约：意图模式下按键只解析 IntentPreviewAction（y/return=continue、
 * n/escape=veto、a=alternative 仅当有 alternatives），绝不落入 inputLine。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import type { IntentPreview } from '../../../agent/intent-preview.js'
import { MockOut, MockIn } from './_harness.js'

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

const baseIntent: IntentPreview = {
  summary: '处理 src/agent/loop.ts',
  confidence: 0.6,
  warnings: ['high commit threshold'],
}

test('意图模式 y → continue', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onIntentPreview!(baseIntent).then(r => { resolved = r })
  await tick()
  stdin.dataHandler!('y')
  await tick()
  assert.equal(resolved, 'continue', 'y 应 continue')
})

test('意图模式 Enter → continue', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onIntentPreview!(baseIntent).then(r => { resolved = r })
  await tick()
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(resolved, 'continue', 'Enter 应 continue')
})

test('意图模式 n → veto', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onIntentPreview!(baseIntent).then(r => { resolved = r })
  await tick()
  stdin.dataHandler!('n')
  await tick()
  assert.equal(resolved, 'veto', 'n 应 veto')
})

test('意图模式 Esc → veto', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onIntentPreview!(baseIntent).then(r => { resolved = r })
  await tick()
  stdin.dataHandler!('\x1B')
  // lone ESC 有 40ms 刷新超时（区分方向键等序列），等它派发
  await new Promise(r => setTimeout(r, 60))
  assert.equal(resolved, 'veto', 'Esc 应 veto')
})

test('意图模式 a（有 alternatives）→ alternative', async () => {
  const { app, stdin } = makeApp()
  const withAlt: IntentPreview = { ...baseIntent, alternatives: ['先扩大搜索确认影响面'] }
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onIntentPreview!(withAlt).then(r => { resolved = r })
  await tick()
  stdin.dataHandler!('a')
  await tick()
  assert.equal(resolved, 'alternative', 'a 应 alternative')
})

test('意图模式 a（无 alternatives）→ 被吞，仍 pending', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onIntentPreview!(baseIntent).then(r => { resolved = r })
  await tick()
  stdin.dataHandler!('a')
  await tick()
  assert.ok(typeof resolved === 'symbol', '无 alternatives 时 a 不应 resolve')
})

test('意图模式按键不污染输入框（不 submit）', async () => {
  const { app, stdin } = makeApp()
  let submitCount = 0
  app.onSubmit(() => { submitCount++ })
  app.setInput('SHOULD_NOT_SUBMIT')
  void app.callbacks.onIntentPreview!(baseIntent)
  await tick()
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(submitCount, 0, '意图态 Enter 不应提交输入框文本')
})
