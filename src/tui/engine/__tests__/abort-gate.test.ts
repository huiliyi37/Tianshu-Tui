/**
 * T9 abort 门禁测试（B2）。
 *
 * Bug：旧 gate 仅 isStreaming||isThinking，submit 后首 token 前 / 纯工具回合
 * 这些窗口 agentBusy=true 但 gate=false → Ctrl+C / Esc 打不断。
 *
 * 契约：agent 活跃（agentBusy 或 phase!=idle）时 Ctrl+C / Esc 触发 abort 一次。
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

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

test('agentBusy（首 token 前）Ctrl+C → abort 一次', async () => {
  const { app, stdin } = makeApp()
  let aborts = 0
  app.onAbort(() => { aborts++ })
  // 经 submit 路径置 agentBusy=true（首 token 尚未到达，isStreaming/isThinking 仍 false）
  app.setInput('hello')
  stdin.dataHandler!('\r')
  await tick()

  stdin.dataHandler!('\x03') // Ctrl+C
  await tick()
  assert.equal(aborts, 1, '活跃窗口 Ctrl+C 应 abort 一次')
})

test('agentBusy（首 token 前）Esc → abort 一次', async () => {
  const { app, stdin } = makeApp()
  let aborts = 0
  app.onAbort(() => { aborts++ })
  app.setInput('hello')
  stdin.dataHandler!('\r')
  await tick()

  stdin.dataHandler!('\x1B') // lone ESC → 超时后派发
  await tick(80)
  assert.equal(aborts, 1, '活跃窗口 Esc 应 abort 一次')
})

test('idle 状态 Esc 不 abort（仅清空输入）', async () => {
  const { app, stdin } = makeApp()
  let aborts = 0
  app.onAbort(() => { aborts++ })
  app.setInput('draft text')
  stdin.dataHandler!('\x1B')
  await tick(80)
  assert.equal(aborts, 0, 'idle 不应 abort')
})
