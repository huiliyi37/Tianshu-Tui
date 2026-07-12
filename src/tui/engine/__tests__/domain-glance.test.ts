/**
 * T9 /domain → GlanceBar 接线测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

class MockOut {
  columns = 100
  rows = 40
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
    cols: 100, rows: 40, modelName: 'test',
  })
  return { app, out }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
const glanceFromOutput = (out: MockOut) => stripAnsi(out.chunks.join(''))

test('setSessionStarDomain 切换 GlanceBar 显示', () => {
  const { app, out } = makeApp()
  app.start()
  out.chunks.length = 0
  app.setSessionStarDomain('天权')
  const plain = glanceFromOutput(out)
  assert.ok(plain.includes('天权'), `expected 天权 in glance: ${plain.slice(0, 200)}`)
})

test('turnComplete 后保留 /domain 设定的星域（不清回默认）', async () => {
  const { app, out } = makeApp()
  app.start()
  app.setSessionStarDomain('天权')
  out.chunks.length = 0
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await new Promise(r => setTimeout(r, 20))
  const plain = glanceFromOutput(out)
  assert.ok(plain.includes('天权'), `session domain persists: ${plain.slice(0, 200)}`)
})

test('委派期间显示天机，turn 结束恢复会话星域', async () => {
  const { app, out } = makeApp()
  app.start()
  app.setSessionStarDomain('天权')
  app.callbacks.onToolUse('d1', 'delegate_task', { objective: 'explore' })
  assert.ok(glanceFromOutput(out).includes('天机'))

  out.chunks.length = 0
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await new Promise(r => setTimeout(r, 20))
  const plain = glanceFromOutput(out)
  assert.ok(plain.includes('天权'), `restored to 天权: ${plain}`)
  assert.ok(!plain.includes('天机'), 'delegation override cleared')
})
