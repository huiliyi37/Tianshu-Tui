/**
 * Ctrl+V focus-debounce RED tests (TuiApp integration).
 *
 * Plan promised: "if `Date.now() - this.lastInputFocusAt < FOCUS_DEBOUNCE_MS`,
 * skip clipboard image read". This is a TuiApp-level behavior, not a
 * clipboard-image module behavior — requires integration test with real
 * TuiApp + mocked clipboard.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { setClipboardReader, FOCUS_DEBOUNCE_MS } from '../clipboard-image.js'
import { MockOut, MockIn } from './_harness.js'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`

/** 轮询直到墙钟确定越过焦点防抖窗口——固定 sleep 在全量测试满载时会迟到不足 */
async function clearFocusDebounce(focusAt: number): Promise<void> {
  while (Date.now() - focusAt < FOCUS_DEBOUNCE_MS + 150) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

function makeApp() {
  const out = new MockOut(120, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120,
    rows: 24,
    modelName: 'test',
    contextWindow: 200_000,
  })
  return { app, out, stdin }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

/** Capture the data URL that ends up attached to InputLine via the public
 *  `getInputImagesCount()` accessor. Falls back to reading the live render
 *  if the accessor is missing (RED signal for the missing-method gap). */
function getAttachedImageCount(app: TuiApp, out: MockOut): number {
  const fn = (app as unknown as { getInputImagesCount?: () => number }).getInputImagesCount
  if (typeof fn === 'function') return fn.call(app)
  // Fallback: grep the rendered output for the image badge.
  // The render path emits "📎 N image(s)" below the input box when N > 0
  // (app.ts: renderLiveImpl around line 4130).
  const visible = out.chunks.join('').replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
  const m = visible.match(/📎 (\d+) image/)
  return m ? Number(m[1]) : 0
}

test('RED: TuiApp+Ctrl+V within 1s focus window → text fallback, no image attached', async () => {
  // Spy: image reader records call count.
  let imageReadCalls = 0
  setClipboardReader({
    async readImage() {
      imageReadCalls++
      return { dataUrl: PNG_DATA_URL, mime: 'image/png', name: 'clip.png', source: 'png' as const }
    },
  })
  let textReadCalls = 0
  const origText = (await import('../clipboard-image.js')).readTextFromClipboard
  // Monkey-patch text reader so we can count its calls independently
  // (test injection isn't available; we rely on a sentinel value).
  const { app, out, stdin } = makeApp()
  app.start() // sets lastInputFocusAt = now

  // Immediately (within 1s) hit Ctrl+V
  stdin.dataHandler!('\x16') // SYN = 0x16 = Ctrl+V
  await tick(50)

  assert.equal(imageReadCalls, 0, 'focus debounce must skip image read within 1s window')
  setClipboardReader(null)
  // Note: text reader count is not directly observable through TuiApp's
  // public API — fallback path is best-effort. Test just asserts image
  // reader was NOT called.
})

test('RED: TuiApp+Ctrl+V after 1s focus window → image reader called, image attached', async () => {
  let imageReadCalls = 0
  setClipboardReader({
    async readImage() {
      imageReadCalls++
      return { dataUrl: PNG_DATA_URL, mime: 'image/png', name: 'clip.png', source: 'png' as const }
    },
  })
  const { app, out, stdin } = makeApp()
  const focusAt = Date.now()
  app.start()

  // Wait past FOCUS_DEBOUNCE_MS to clear the debounce window
  await clearFocusDebounce(focusAt)

  stdin.dataHandler!('\x16')
  await tick(50)

  assert.equal(imageReadCalls, 1, 'after 1s debounce window, image reader must be called once')
  assert.equal(getAttachedImageCount(app, out), 1, 'one image must be attached to InputLine')

  setClipboardReader(null)
})

test('RED: TuiApp+Ctrl+V with no image (null) → text fallback, 0 images', async () => {
  setClipboardReader({
    async readImage() {
      return null
    },
  })
  const { app, out, stdin } = makeApp()
  const focusAt = Date.now()
  app.start()
  await clearFocusDebounce(focusAt)

  stdin.dataHandler!('\x16')
  await tick(50)

  assert.equal(getAttachedImageCount(app, out), 0, 'no image attached when clipboard has no image')

  setClipboardReader(null)
})

test('RED: TuiApp+Ctrl+V in non-input mode (overlay) → handler short-circuits, no reads', async () => {
  let imageReadCalls = 0
  setClipboardReader({
    async readImage() {
      imageReadCalls++
      return { dataUrl: PNG_DATA_URL, mime: 'image/png', name: 'clip.png', source: 'png' as const }
    },
  })
  const { app, stdin } = makeApp()
  const focusAt = Date.now()
  app.start()
  await clearFocusDebounce(focusAt)

  // Force the input handler into a non-input mode (simulate overlay active)
  ;(app as unknown as { input: { setMode: (m: string) => void } }).input.setMode('overlay')
  stdin.dataHandler!('\x16')
  await tick(50)

  assert.equal(imageReadCalls, 0, 'Ctrl+V in overlay mode must not trigger image read')
  setClipboardReader(null)
})
