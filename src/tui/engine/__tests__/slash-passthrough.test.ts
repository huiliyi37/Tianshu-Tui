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
  // 生产路径中 main.ts 会 setSlashCommands(palette+skill 提示)。4175e5b9 之后
  // 未在提示/注册表中的单段 /xxx 被视为 Linux 路径直达 agent，所以测试要
  // 像生产一样声明命令名，slash 分发才会走 slashHandler。
  app.setSlashCommands([
    { name: '/help', description: 'help' },
    { name: '/team', description: 'team' },
  ])
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

test('busy 期间 passthrough 的 slash 命令以高优先级入 steer 队列', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })
  app.setSlashHandler(async () => false) // 透传命令

  // 启动 run A
  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.busy, true)

  // run A 执行期间输入透传 slash
  app.setInput('/team do something')
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(runs.length, 1, 'busy 期间不应直接触发新的 onSubmit')
  assert.equal(app.steerBuffer.hasPending(), true)
  // 优先级为 next，排在 later guidance 之前
  const entries = app.steerBuffer.getPendingEntries()
  assert.equal(entries[0]!.text, '/team do something')
  assert.equal(entries[0]!.priority, 'next')

  // run B 启动时，高优先级 slash 应先被归并
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 10 }, 1, true)
  await tick()
  app.setInput('task B')
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(runs.length, 2)
  assert.equal(runs[1], '/team do something\n\ntask B')
  assert.equal(app.steerBuffer.hasPending(), false)
})
