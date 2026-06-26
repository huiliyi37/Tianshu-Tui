/**
 * Overlay deactivate 回归测试 — 防止 domain/model/theme picker 切换后
 * 出现的三种回归：
 *
 * 1. Ghost rendering：旧帧残留（exec 在 deactivate 之后运行）
 * 2. 输入框消失：deactivateOverlay 没正确恢复 live region
 * 3. 输入框跑到屏幕顶部：cursorUp(999) 全屏擦除把 append 起点拉到顶
 *
 * 这些 bug 在历史上反复出现（314c54f2, c8acfec9, a169152b, 以及
 * 027744ae / bb6a9329 / 03f73669 / e6ba2a27 序列）。此测试锁定正确行为。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'

describe('Overlay deactivate · picker exit regression', () => {
  it('deactivateOverlay writes exactly one live region after overlay exit', () => {
    const { app, out } = makeApp()
    out.clear()

    // Simulate: activate overlay → deactivate
    app.activateOverlay('domain-picker')
    out.clear() // discard activate's output
    app.deactivateOverlay()

    // After deactivate, screen should have exactly one input box border (╭)
    const allOutput = out.chunks.join('')
    const topBorders = allOutput.match(/╭/g) ?? []
    assert.equal(topBorders.length, 1, `Expected 1 top border after deactivate, got ${topBorders.length}`)
  })

  it('deactivateOverlay does not use cursorUp(999) which moves input to screen top', () => {
    const { app, out } = makeApp()
    app.start() // paint initial live region
    out.clear()

    app.activateOverlay('domain-picker')
    out.clear()
    app.deactivateOverlay()

    const output = out.chunks.join('')
    // cursorUp(999) = \x1B[999A — must NOT appear (it moves cursor to screen top)
    assert.doesNotMatch(output, /\x1B\[999A/, 'cursorUp(999) must not be used — it sends input box to screen top')
  })

  it('deactivateOverlay produces output containing the input prompt (〉)', () => {
    const { app, out } = makeApp()
    app.start()
    out.clear()

    app.activateOverlay('model-picker')
    out.clear()
    app.deactivateOverlay()

    const output = out.chunks.join('')
    const plain = stripAnsi(output)
    assert.ok(plain.includes('〉'), 'Input prompt symbol 〉 must be present after deactivate')
  })

  it('successive activate/deactivate cycles do not accumulate ghost frames', () => {
    const { app, out } = makeApp()
    app.start()

    for (let i = 0; i < 3; i++) {
      app.activateOverlay('theme-picker')
      out.clear()
      app.deactivateOverlay()
    }

    const output = out.chunks.join('')
    const topBorders = output.match(/╭/g) ?? []
    assert.equal(topBorders.length, 1, `Expected 1 top border after 3 cycles, got ${topBorders.length} — ghost accumulation`)
  })

  it('deactivateOverlay after deactivateOverlay is safe (no crash, renders live region)', () => {
    const { app, out } = makeApp()
    app.activateOverlay('domain-picker')
    app.deactivateOverlay()
    out.clear()
    // Second deactivate without activate — overlay.deactivate() is a no-op,
    // but deactivateOverlay still calls renderLive (harmless repaint).
    app.deactivateOverlay()
    const output = out.chunks.join('')
    const plain = stripAnsi(output)
    assert.ok(plain.includes('〉'), 'Double deactivate should still render input box without crashing')
  })
})
