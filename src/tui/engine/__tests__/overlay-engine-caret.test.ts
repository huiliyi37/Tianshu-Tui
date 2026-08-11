/**
 * OverlayEngine 硬件 caret 支持回归：
 * - caret() 提供落点 → 帧后定位并 SHOW（输入类 overlay 的"格子边界"光标）
 * - caret() 返回 null → HIDE；行 diff 为空的闪烁帧仍会翻转光标可见性
 * - 无 caret() 的渲染器维持"空 diff 零输出"短路
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OverlayEngine } from '../overlay-engine.js'

class FakeOut {
  chunks: string[] = []
  write = (s: string): boolean => {
    this.chunks.push(s)
    return true
  }
}

function makeEngine(out: FakeOut): OverlayEngine {
  return new OverlayEngine({
    stdout: out as never,
    getSize: () => ({ cols: 40, rows: 10 }),
  })
}

test('OverlayEngine: caret() positions and shows the hardware cursor after the frame', () => {
  const out = new FakeOut()
  const engine = makeEngine(out)
  engine.register('input-like', {
    render: () => ['line1', 'line2'],
    caret: () => ({ row: 2, col: 5 }),
  })
  engine.activate('input-like')
  const all = out.chunks.join('')
  assert.ok(all.includes('\x1B[?1049h'), '进入 alt screen')
  assert.match(all, /\x1B\[2;5H\x1B\[6 q\x1B\[\?25h/, '帧后定位到 caret，切稳态竖条并显示硬件光标')
})

test('OverlayEngine: blink frame with empty diff still toggles caret visibility', () => {
  let visible = true
  const out = new FakeOut()
  const engine = makeEngine(out)
  engine.register('input-like', {
    render: () => ['same'],
    caret: () => (visible ? { row: 1, col: 1 } : null),
  })
  engine.activate('input-like')
  out.chunks = []
  visible = false
  engine.rerender() // 行内容未变——只有 caret 可见性翻转
  assert.equal(out.chunks.join(''), '\x1B[?25l', '空 diff 帧仍写出 HIDE')
})

test('OverlayEngine: renderer without caret() keeps the zero-output short circuit', () => {
  const out = new FakeOut()
  const engine = makeEngine(out)
  engine.register('static', { render: () => ['x'] })
  engine.activate('static')
  out.chunks = []
  engine.rerender()
  assert.equal(out.chunks.length, 0, '无 caret 的 overlay 空 diff 不写任何字节')
})

test('OverlayEngine: leaving alt screen shows the cursor again', () => {
  const out = new FakeOut()
  const engine = makeEngine(out)
  engine.register('input-like', {
    render: () => ['x'],
    caret: () => ({ row: 1, col: 1 }),
  })
  engine.activate('input-like')
  out.chunks = []
  engine.deactivate()
  const all = out.chunks.join('')
  assert.ok(all.includes('\x1B[0 q'), '退出前恢复终端默认光标形状')
  assert.match(all, /\x1B\[\?25h/, '退出前恢复硬件光标')
  assert.ok(all.includes('\x1B[?1049l'), '退回主屏')
})
