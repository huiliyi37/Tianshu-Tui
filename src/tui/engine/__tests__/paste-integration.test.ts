/**
 * T9 bracketed paste 集成测试（C1）。
 *
 * 契约：
 * - start() 写 \x1B[?2004h，dispose() 写 \x1B[?2004l。
 * - 粘贴多行（含 \r）经 200~/201~ 包裹 → 整段插入输入框，不触发 submit。
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

test('start/dispose 切换 bracketed paste 模式', () => {
  const { app, out } = makeApp()
  app.start()
  assert.ok(out.chunks.some(c => c.includes('\x1B[?2004h')), 'start 启用 paste')
  app.dispose()
  assert.ok(out.chunks.some(c => c.includes('\x1B[?2004l')), 'dispose 关闭 paste')
})

test('多行粘贴整段进输入框，不触发 submit', async () => {
  const { app, stdin } = makeApp()
  let submits = 0
  app.onSubmit(() => { submits++ })

  stdin.dataHandler!('\x1B[200~line1\r\nline2\x1B[201~')
  await tick()

  assert.equal(app.getInputValue(), 'line1\nline2', '两行合一、CRLF 规范化')
  assert.equal(submits, 0, '粘贴不应触发 submit')
})

test('粘贴插入到光标处（已有文本之间）', async () => {
  const { app, stdin } = makeApp()
  app.setInput('AB')
  // 光标在末尾；先左移一位到 A|B
  stdin.dataHandler!('\x1B[D')
  await tick()
  stdin.dataHandler!('\x1B[200~X\x1B[201~')
  await tick()
  assert.equal(app.getInputValue(), 'AXB', '插入到光标处')
})
