/**
 * T9 slash 透传测试。
 *
 * Bug：handleSlashCommand 遇到 async slashHandler 时无条件返回 true，
 * 导致透传命令（/team、/review、/plan <x>）的输入被吞，agent 永远收不到。
 *
 * 契约：await handler 结果——resolve(false) 时透传给 onSubmit，resolve(true) 时不透传。
 *
 * 追加（Phase 6）：passthrough 时也应 commit 用户气泡到 scrollback，
 * 而非仅有 agent 回复无用户输入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
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

test('async slashHandler resolve(false) → 输入透传给 agent', async () => {
  const { app, stdin } = makeApp()
  let passed: string | null = null
  app.onSubmit((t) => { passed = t })
  app.setSlashHandler(async () => false) // 模拟 /team 等透传命令
  app.setInput('/team do something')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(passed, '/team do something', 'resolve(false) 应透传给 onSubmit')
})

test('async slashHandler resolve(true) → 不透传（已处理）', async () => {
  const { app, stdin } = makeApp()
  let passed: string | null = null
  app.onSubmit((t) => { passed = t })
  app.setSlashHandler(async () => true) // 模拟 /help 等本地命令
  app.setInput('/help')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(passed, null, 'resolve(true) 不应透传')
})

test('提交后输入框被清空', async () => {
  const { app, stdin } = makeApp()
  app.setSlashHandler(async () => true)
  app.setInput('/help')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.getModelInfo().modelName, 'test') // sanity
})

test('passthrough 后 scrollback 包含用户气泡', async () => {
  const { app, stdin } = makeApp()
  let passed: string | null = null
  app.onSubmit((t) => { passed = t })
  app.setSlashHandler(async () => false) // 透传，如 /team

  // 用 /team 而非 /review (后者在 main 层会被 resolveAppPromptInput 解析为 null
  // 并触发 rejectSubmit)，单测只覆盖 TuiApp 层透传行为。
  app.setInput('/team plan.md')
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(passed, '/team plan.md', '应透传给 agent')
  const scrollback = app.getScrollbackContent()
  // ANSI 转义码穿插，无法做字面匹配，仅断言用户气泡标记（❯/▌）与原文存在
  assert.ok(/[❯▌]/.test(scrollback), 'scrollback 应包含用户气泡标记（❯/▌）')
  assert.ok(scrollback.includes('/team plan.md'), 'scrollback 应包含用户原始输入')
})
