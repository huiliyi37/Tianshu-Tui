/**
 * T9 bracketed paste 集成测试（C1）。
 *
 * 契约：
 * - start() 写 \x1B[?2004h，dispose() 写 \x1B[?2004l。
 * - 粘贴多行（含 \r）经 200~/201~ 包裹 → 整段插入输入框，不触发 submit。
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { setClipboardReader } from '../clipboard-image.js'
import { MockOut, MockIn } from './_harness.js'

// 粘贴测试隔离系统剪贴板——onPaste 现在会先尝试读剪贴板图片（修复右键粘贴丢图），
// 测试环境注入「无图」reader 确保走文本路径，不受本机剪贴板当前内容影响。
beforeEach(() => { setClipboardReader({ readImage: async () => null }) })
afterEach(() => { setClipboardReader(null) })

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

test('右键粘贴：剪贴板有图时附图，不插入乱码文本', async () => {
  // 模拟右键粘贴——终端把图片字节当文本注入 stdin（bracketed paste 包裹），
  // 同时系统剪贴板里确实有图。onPaste 应优先读剪贴板附图，吞掉乱码文本。
  setClipboardReader({ readImage: async () => ({ dataUrl: 'data:image/png;base64,iVBOR=', mime: 'image/png', name: 'clipboard.png', source: 'png' }) })
  const { app, stdin } = makeApp()
  app.start()
  // 模拟终端注入的图片字节乱码（实际是二进制被 UTF-8 解码的残留）
  stdin.dataHandler!('\x1B[200~\ufffd\ufffd\ufffd\x00\x01\x02\x1b[201~')
  await tick(30)
  // 图片被附加（不是文本）
  assert.equal(app.getInputImagesCount(), 1, '应附加 1 张图片')
  assert.equal(app.getInputValue(), '', '乱码文本不应进入输入框')
  app.dispose()
})

test('右键粘贴：剪贴板无图时正常插入文本', async () => {
  // 无图时 onPaste 应回退到文本路径（已由 beforeEach 的 null reader 覆盖，
  // 这里显式再测一次确保回退逻辑正确）
  setClipboardReader({ readImage: async () => null })
  const { app, stdin } = makeApp()
  app.start()
  stdin.dataHandler!('\x1B[200~hello world\x1B[201~')
  await tick(30)
  assert.equal(app.getInputValue(), 'hello world', '无图时文本正常插入')
  assert.equal(app.getInputImagesCount(), 0, '不应附加图片')
  app.dispose()
})
