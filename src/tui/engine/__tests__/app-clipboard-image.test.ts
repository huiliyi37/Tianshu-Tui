/**
 * RED tests — TuiApp-level integration coverage for Ctrl+V clipboard image paste.
 *
 * Single-test-gap (unit-level only) was a TDD depth regression in commit 9e126c7c:
 * clipboard-image.test.ts covers `readImageFromClipboard` + `tryShellClipboard` in
 * isolation, but NO test verifies the wiring: TuiApp.onAnyKey(ctrl_v) →
 * handleCtrlV → inputLine.addImage(dataUrl). This file fills that gap.
 *
 * Wave 1 RED: these tests must fail (or be impossible to compile) BEFORE we add
 * the public surface (TuiApp.getInputImagesCount) and the mock-spy wiring.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'
import { setClipboardReader } from '../clipboard-image.js'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`

function makeApp() {
  const out = new MockOut(120, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24, modelName: 'test',
  })
  return { app, out, stdin }
}

const tick = (ms = 20) => new Promise<void>(r => setTimeout(r, ms))

// ── RED #1: TuiApp 必须暴露 image count 给测试断言 ──────────────────
// 当前没有 getInputImagesCount() 公共方法，下面的 (app as any).images 必然红。
test('RED #1: TuiApp exposes getInputImagesCount for assertion', () => {
  const { app } = makeApp()
  // 此断言先 RED（方法不存在）→ 实施时新增 public getInputImagesCount
  assert.equal(typeof (app as any).getInputImagesCount, 'function',
    'TuiApp must expose getInputImagesCount() for integration tests')
  assert.equal((app as any).getInputImagesCount(), 0, 'starts with zero images')
})

// ── RED #2: Ctrl+V 走 onAnyKey → handleCtrlV → inputLine.addImage ──────
// 这是真正的接线断言：mock reader 注入 data URL，按 Ctrl+V，断言
// inputLine.images 真的多了 1 个。
test('RED #2: Ctrl+V onAnyKey → handleCtrlV → inputLine.addImage (end-to-end wiring)', async () => {
  const { app, stdin } = makeApp()
  app.start()
  // 注入 mock：reader 返回固定 data URL
  setClipboardReader({
    async readImage() {
      return { dataUrl: PNG_DATA_URL, mime: 'image/png', name: 'clip.png', source: 'png' as const }
    },
  })

  // 触发 Ctrl+V：input-handler.ts:115 把 0x16 映射为 'ctrl_v'
  // 绕开 1s 焦点防抖：start() 已置 lastInputFocusAt = Date.now()，手动设到 2s 前
  ;(app as any).lastInputFocusAt = Date.now() - 2_000
  stdin.dataHandler!('\x16')
  await tick(50)  // 等 handleCtrlV 的 async 完成

  setClipboardReader(null)

  // 接线断言：TuiApp 真把 data URL 灌进了 inputLine.images
  // 当前 (app as any).getInputImagesCount 不存在 → 红
  assert.equal((app as any).getInputImagesCount(), 1,
    'after Ctrl+V with image in clipboard, inputLine must have 1 image')
  // 同时断言 value 不被污染（图片不是文本）
  assert.equal(app.getInputValue(), '', 'image paste must not pollute text value')
})

// ── RED #3: 剪贴板里没图 → fallback 到文本 Ctrl+V ─────────────────────
test('RED #3: Ctrl+V with no image in clipboard → text fallback', async () => {
  const { app, stdin } = makeApp()
  setClipboardReader({
    async readImage() { return null },
    async readText() { return 'clipboard text' },
  })
  app.start()
  ;(app as any).lastInputFocusAt = Date.now() - 2_000

  stdin.dataHandler!('\x16')
  await tick(50)

  setClipboardReader(null)

  // reader 报 null → handleCtrlV 调 readTextFromClipboard 走文本路径
  // 接线断言：images 不增，value 插入 mock 文本
  assert.equal((app as any).getInputImagesCount(), 0, 'no image → no addImage call')
  assert.equal(app.getInputValue(), 'clipboard text', 'no image → text fallback is inserted')
})

// ── RED #4: 焦点防抖 1s 内的 Ctrl+V 跳过剪贴板读图 ───────────────────
test('RED #4: Ctrl+V within 1s focus debounce → skip image read', async () => {
  const { app, stdin } = makeApp()
  let readCalls = 0
  setClipboardReader({
    async readImage() { readCalls++; return null }
  })
  app.start()
  // start() 已置 lastInputFocusAt = Date.now()，立即按 Ctrl+V 应在 1s 窗口内
  stdin.dataHandler!('\x16')
  await tick(30)
  setClipboardReader(null)

  assert.equal(readCalls, 0, 'reader must not be called during 1s focus debounce')
})

// ── RED #5: 焦点防抖窗口外 → 真调 reader ────────────────────────────
test('RED #5: Ctrl+V after 1s debounce → reader is called', async () => {
  const { app, stdin } = makeApp()
  let readCalls = 0
  setClipboardReader({
    async readImage() { readCalls++; return null }
  })
  app.start()
  // 模拟时间走 1.1s（直接改 lastInputFocusAt 私有字段）
  ;(app as any).lastInputFocusAt = Date.now() - 1100

  stdin.dataHandler!('\x16')
  await tick(50)
  setClipboardReader(null)

  assert.equal(readCalls, 1, 'reader is called once after debounce window')
})

// ── RED #6: 达到 MAX_IMAGES (4) 上限 → 不再 addImage，commitStatic 警告 ─
test('RED #6: at MAX_IMAGES cap → no addImage, warning committed', async () => {
  const { app, out, stdin } = makeApp()
  app.start()
  // 灌满 4 张
  for (let i = 0; i < 4; i++) {
    setClipboardReader({
      async readImage() { return { dataUrl: `${PNG_DATA_URL}#${i}`, mime: 'image/png', name: `c${i}.png`, source: 'png' as const } }
    })
    ;(app as any).lastInputFocusAt = Date.now() - 1100
    stdin.dataHandler!('\x16')
    await tick(50)
  }
  setClipboardReader(null)

  // 第 5 张
  setClipboardReader({
    async readImage() { return { dataUrl: `${PNG_DATA_URL}#5`, mime: 'image/png', name: 'c5.png', source: 'png' as const } }
  })
  ;(app as any).lastInputFocusAt = Date.now() - 1100
  stdin.dataHandler!('\x16')
  await tick(50)
  setClipboardReader(null)

  assert.equal((app as any).getInputImagesCount(), 4, 'capped at 4 images')
  const visible = out.chunks.join('').replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
  assert.ok(visible.includes('最多附加 4 张图片'), 'warning "最多附加 4 张图片" must be committed')
})
