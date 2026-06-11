/**
 * T9 slash 透传测试。
 *
 * Bug：handleSlashCommand 遇到 async slashHandler 时无条件返回 true，
 * 导致透传命令（/team、/review、/plan <x>）的输入被吞，agent 永远收不到。
 *
 * 契约：await handler 结果——resolve(false) 时透传给 onSubmit，resolve(true) 时不透传。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

class MockOut {
  columns = 80
  rows = 24
  chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

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
