import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStanceTally } from '../stance-tally.js'
import type { VirtueSignal } from '../virtue-signals.js'

function sig(wuchang: VirtueSignal['wuchang'], evidence: string): VirtueSignal {
  return { type: 'independent-judgment', confidence: 0.9, wuchang, evidence }
}

describe('createStanceTally', () => {
  it('returns null with no recorded signals', () => {
    assert.equal(createStanceTally().render(), null)
  })

  it('tallies by wuchang and surfaces the latest evidence', () => {
    const t = createStanceTally()
    t.record(sig('仁', '质疑了用户的前提'))
    t.record(sig('仁', '再次质疑'))
    t.record(sig('义', '主动跑了测试'))
    const out = t.render()!
    assert.match(out, /仁\(质疑而非附和\)×2/)
    assert.match(out, /义\(主动验证\)×1/)
    assert.match(out, /最近一次：主动跑了测试/)
  })
})

// ─── T5 renderMirror — Fibonacci 桶字节稳定 ──────────────────────
// 通道 A (appendixDelta)，字节稳定是缓存安全声称的全部根据。
// 参照 cognitive-mirror.test.ts 的粗粒断言模式。

describe('createStanceTally — renderMirror (T5 字节稳定)', () => {
  it('A1: 无信号 → null', () => {
    assert.equal(createStanceTally().renderMirror(), null)
  })

  it('A2: 单信号 仁×1', () => {
    const t = createStanceTally()
    t.record(sig('仁', '质疑了用户的前提'))
    assert.equal(t.renderMirror(), 'virtue="仁×1"')
  })

  it('A3: 仁×3+义×5 固定排序仁义礼智信', () => {
    const t = createStanceTally()
    for (let i = 0; i < 3; i++) t.record(sig('仁', '质疑'))
    for (let i = 0; i < 5; i++) t.record(sig('义', '验证'))
    // 固定排序：仁义礼智信，不按计数排序
    assert.equal(t.renderMirror(), 'virtue="仁×3·义×5"')
  })

  it('A4: 字节稳定 — 桶内 4→5 计数不变（Fibonacci 桶 4-5→5）', () => {
    const t4 = createStanceTally()
    for (let i = 0; i < 4; i++) t4.record(sig('仁', '质疑'))
    assert.equal(t4.renderMirror(), 'virtue="仁×5"')

    const t5 = createStanceTally()
    for (let i = 0; i < 5; i++) t5.record(sig('仁', '质疑'))
    assert.equal(t5.renderMirror(), 'virtue="仁×5"')
    // 同桶输出 ===（字节稳定核心断言）
    assert.equal(t4.renderMirror(), t5.renderMirror())
  })

  it('A5: 跨桶变 — 3→4 输出变化（Fibonacci 桶 3→5）', () => {
    const t3 = createStanceTally()
    for (let i = 0; i < 3; i++) t3.record(sig('仁', '质疑'))
    assert.equal(t3.renderMirror(), 'virtue="仁×3"')

    const t4 = createStanceTally()
    for (let i = 0; i < 4; i++) t4.record(sig('仁', '质疑'))
    assert.equal(t4.renderMirror(), 'virtue="仁×5"')

    assert.notEqual(t3.renderMirror(), t4.renderMirror())
  })

  it('A6: 输出为单行自闭合属性（无换行、无自然语言）', () => {
    const t = createStanceTally()
    t.record(sig('仁', '质疑'))
    t.record(sig('信', '缓存'))
    const mirror = t.renderMirror()!
    assert.equal(mirror.split('\n').length, 1, '应为单行')
    assert.ok(mirror.startsWith('virtue="'), '应以 virtue=" 开头')
    assert.ok(mirror.endsWith('"'), '应以 " 结尾')
    // 无自然语言文本（无中文描述/括号/冒号）
    assert.ok(!mirror.includes('质疑'), '不应含证据文本')
    assert.ok(!mirror.includes('缓存'), '不应含证据文本')
    assert.ok(!mirror.includes('('), '不应含手写体标签')
  })
})
