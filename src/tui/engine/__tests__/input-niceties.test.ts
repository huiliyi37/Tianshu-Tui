/**
 * T9 输入框文本输入打磨测试（Block D）。
 *
 * D1: CJK/emoji 光标按 grapheme 步进（一次跨一个用户字符）。
 * D2: 多行 Up/Down 行内导航，单行/边界回退到历史。
 * D3: `\`+Enter 续行后光标落在换行符之后。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InputLine } from '../input-line.js'

describe('D1 · grapheme-aware cursor', () => {
  it('moveLeft steps over a whole emoji cluster', () => {
    const family = '👨‍👩‍👧' // ZWJ 家庭 emoji，多个 code point
    const input = new InputLine({ value: family })
    assert.equal(input.cursor, family.length, 'cursor at end (code units)')
    input.handleKey('left', '', false, false)
    assert.equal(input.cursor, 0, '一次左移跨过整个 emoji 簇')
  })

  it('backspace deletes a whole CJK char (single move)', () => {
    const input = new InputLine({ value: '你好' })
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, '你', '删掉一个完整汉字')
  })

  it('moveRight/backspace handle emoji from start', () => {
    const input = new InputLine({ value: '🎉ok' })
    input.handleKey('home', '', false, false)
    input.handleKey('right', '', false, false)
    // 光标应越过整个 🎉（surrogate pair），落在 'o' 前
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, 'ok', '删掉整个 emoji')
  })
})

describe('D2 · multi-line Up/Down', () => {
  it('Up moves cursor to previous line (multi-line)', () => {
    const input = new InputLine({ value: 'abc\ndef' })
    // cursor at end (line 1, col 3)
    input.handleKey('up', '', false, false)
    // 应移到第 0 行同列（col 3 → 行尾 'abc' 长度 3）
    assert.equal(input.cursor, 3)
  })

  it('Down moves cursor to next line', () => {
    const input = new InputLine({ value: 'abc\ndef' })
    input.handleKey('home', '', false, false) // line1 col0
    input.handleKey('up', '', false, false)   // line0 col0
    assert.equal(input.cursor, 0)
    input.handleKey('down', '', false, false) // back to line1 col0
    assert.equal(input.cursor, 4)
  })

  it('single-line Up falls back to history', () => {
    let historyValue: string | null = null
    const input = new InputLine({ value: 'current', history: ['prev1'], onChange: (v) => { historyValue = v } })
    input.handleKey('up', '', false, false)
    assert.equal(input.value, 'prev1', '单行 Up 走历史')
    assert.equal(historyValue, 'prev1')
  })
})

describe('D3 · backslash + Enter continuation cursor', () => {
  it('cursor lands after the inserted newline (mid-line)', () => {
    // 'ab\' 光标在末尾，续行后应为 'ab\n'，光标在 \n 之后（pos 3）
    const input = new InputLine({ value: 'ab\\' })
    const ev = input.handleKey('return', '', false, false)
    assert.equal(ev?.type, 'change')
    assert.equal(input.value, 'ab\n')
    assert.equal(input.cursor, 3, '光标在换行符之后')
  })

  it('typing after continuation appends to the new line', () => {
    const input = new InputLine({ value: 'ab\\' })
    input.handleKey('return', '', false, false)
    input.handleKey('', 'c', false, false)
    assert.equal(input.value, 'ab\nc')
    assert.equal(input.cursor, 4)
  })
})
