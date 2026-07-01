import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InputLine } from '../engine/input-line.js'

describe('InputLine multi-line (W4b)', () => {
  it('backslash + Enter continues line instead of submitting', () => {
    const input = new InputLine({ value: 'first line\\' })
    let submitted: string | null = null
    const i2 = new InputLine({ value: 'first line\\', onSubmit: (v) => { submitted = v } })
    const ev = i2.handleKey('return', '', false, false)
    assert.equal(ev?.type, 'change')
    assert.equal(submitted, null)
    assert.equal(i2.value, 'first line\n')
    void input
  })

  it('Enter without trailing backslash submits', () => {
    let submitted: string | null = null
    const input = new InputLine({ value: 'hello\nworld', onSubmit: (v) => { submitted = v } })
    const ev = input.handleKey('return', '', false, false)
    assert.equal(ev?.type, 'submit')
    assert.equal(submitted, 'hello\nworld')
  })

  it('ctrl_j inserts a newline at cursor', () => {
    const input = new InputLine({ value: 'ab' })
    input.handleKey('left', '', false, false)
    const ev = input.handleKey('ctrl_j', '', true, false)
    assert.equal(ev?.type, 'change')
    assert.equal(input.value, 'a\nb')
  })

  it('insertText inserts at cursor and advances cursor', () => {
    const input = new InputLine({ value: 'AB' })
    input.handleKey('left', '', false, false) // cursor at A|B
    input.insertText('XY')
    assert.equal(input.value, 'AXYB')
    // 续插一个字符应落在 XY 之后
    input.insertText('Z')
    assert.equal(input.value, 'AXYZB')
  })

  it('insertText with multi-line text keeps newlines (no submit)', () => {
    const input = new InputLine({ value: '' })
    input.insertText('line1\nline2')
    assert.equal(input.value, 'line1\nline2')
  })

  it('displayLines renders cursor line with 〉 prefix and █ marker', () => {
    const input = new InputLine({ value: 'one\ntwo' })
    // cursor at end → on second line
    const lines = input.displayLines()
    assert.deepEqual(lines, ['  one', '〉 two█'])
  })

  it('displayLines shows placeholder when empty', () => {
    const input = new InputLine({ placeholder: 'Type here' })
    assert.deepEqual(input.displayLines(), ['〉 █Type here'])
  })

  it('displayLines with maxLines keeps the cursor line visible', () => {
    const value = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n')
    const cursor = value.split('\n').slice(0, 6).join('\n').length + 1 // start of line6
    const input = new InputLine({ value })
    input.setValue(value, cursor)

    const lines = input.displayLines({ maxLines: 5 })

    assert.equal(lines.length, 5)
    assert.ok(lines.some(line => line.includes('lines above')))
    assert.ok(lines.some(line => line.includes('lines below')))
    assert.ok(lines.some(line => line.includes('〉 █line6')), 'cursor line must stay visible')
    assert.ok(!lines.some(line => line.includes('line11')), 'viewport should not blindly show only the tail')
  })

  it('placeholder accessor exposes option', () => {
    const input = new InputLine({ placeholder: 'p' })
    assert.equal(input.placeholder, 'p')
  })

  it('displayLines with maxWidth keeps cursor visible on long lines (cursor at end)', () => {
    // 100 chars, cursor at end — line is way wider than maxWidth=20
    const value = 'a'.repeat(100)
    const input = new InputLine({ value })
    const lines = input.displayLines({ maxWidth: 20 })
    assert.equal(lines.length, 1)
    const line = lines[0]!
    // █ (cursor marker) must be visible, not truncated off
    assert.ok(line.includes('█'), 'cursor █ must be visible when line exceeds maxWidth')
    // Right-side ellipsis indicates there's more content after cursor (cursor at end → no right ellipsis)
    // Left-side ellipsis indicates truncated content before cursor
    assert.ok(line.includes('…'), 'must show ellipsis for truncated content')
  })

  it('displayLines with maxWidth centers cursor when typing in the middle', () => {
    const value = 'a'.repeat(100)
    const input = new InputLine({ value })
    input.setValue(value, 50) // cursor at middle
    const lines = input.displayLines({ maxWidth: 20 })
    const line = lines[0]!
    assert.ok(line.includes('█'), 'cursor must be visible')
    assert.ok(line.includes('…'), 'must show truncation indicator')
    // Both sides truncated when cursor is centered (prefix 〉 is always present)
    assert.ok(line.slice(2).startsWith('…'), 'left side truncated when cursor is centered')
    assert.ok(line.endsWith('…'), 'right side truncated when cursor is centered')
  })

  it('displayLines with maxWidth shows tail content when cursor at end (the regression case)', () => {
    // The bug: typing at the end of a long line → truncateToWidth from start
    // hid the last characters the user was actively typing.
    // Fix: hscrollCursorLine centers on cursor so tail is visible.
    const value = 'AAAAAAAAAA' + 'BBBBBBBBBB' + 'CCCCCCCCCC' // 30 chars
    const input = new InputLine({ value })
    const lines = input.displayLines({ maxWidth: 15 })
    const line = lines[0]!
    assert.ok(line.includes('█'), 'cursor must be visible')
    assert.ok(line.includes('C'), 'tail content near cursor must be visible')
    // Should NOT show the very start 'A's — they're scrolled off
    assert.ok(!line.includes('AAAAAAAAAA'), 'head content should be scrolled off when cursor at end')
  })
})

describe('InputLine', () => {
  describe('basic editing', () => {
    it('inserts characters', () => {
      const input = new InputLine()
      input.handleKey('unknown', 'h', false, false)
      input.handleKey('unknown', 'i', false, false)
      assert.equal(input.value, 'hi')
      assert.equal(input.cursor, 2)
    })

    it('handles backspace', () => {
      const input = new InputLine({ value: 'hello' })
      const result = input.handleKey('backspace', '', false, false)
      assert.equal(input.value, 'hell')
      assert.equal(result?.type, 'change')
    })

    it('handles ctrl_h as backspace (Windows PowerShell sends 0x08)', () => {
      const input = new InputLine({ value: 'hello' })
      const result = input.handleKey('ctrl_h', '', true, false)
      assert.equal(input.value, 'hell')
      assert.equal(result?.type, 'change')
    })

    it('handles delete forward', () => {
      const input = new InputLine({ value: 'hello' })
      input.handleKey('left', '', false, false) // cursor at 4, on 'o'
      input.handleKey('delete', '', false, false) // delete char AT cursor
      assert.equal(input.value, 'hell')
    })

    it('ignores backspace at start', () => {
      const input = new InputLine()
      assert.equal(input.handleKey('backspace', '', false, false), null)
    })

    it('ignores delete at end', () => {
      const input = new InputLine({ value: 'a' })
      assert.equal(input.handleKey('delete', '', false, false), null)
    })

    it('inserts at cursor position', () => {
      const input = new InputLine({ value: 'ac' })
      input.handleKey('left', '', false, false)
      input.handleKey('unknown', 'b', false, false)
      assert.equal(input.value, 'abc')
    })
  })

  describe('cursor movement', () => {
    it('moves left and right', () => {
      const input = new InputLine({ value: 'ab' })
      assert.equal(input.cursor, 2)
      input.handleKey('left', '', false, false)
      assert.equal(input.cursor, 1)
      input.handleKey('right', '', false, false)
      assert.equal(input.cursor, 2)
    })

    it('home moves to start', () => {
      const input = new InputLine({ value: 'hello' })
      input.handleKey('home', '', false, false)
      assert.equal(input.cursor, 0)
    })

    it('end moves to end', () => {
      const input = new InputLine({ value: 'hello' })
      input.handleKey('home', '', false, false)
      input.handleKey('end', '', false, false)
      assert.equal(input.cursor, 5)
    })
  })

  describe('Ctrl key combos', () => {
    it('Ctrl+A moves to home', () => {
      const input = new InputLine({ value: 'hello' })
      input.handleKey('ctrl_a', '', true, false)
      assert.equal(input.cursor, 0)
    })

    it('Ctrl+E moves to end', () => {
      const input = new InputLine({ value: 'hello' })
      input.handleKey('ctrl_a', '', true, false)
      input.handleKey('ctrl_e', '', true, false)
      assert.equal(input.cursor, 5)
    })

    it('Ctrl+U deletes to start', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('left', '', false, false)
      input.handleKey('ctrl_u', '', true, false)
      assert.equal(input.value, 'd')
    })

    it('Ctrl+K deletes to end', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('left', '', false, false) // cursor before 'd' (pos 10)
      input.handleKey('ctrl_k', '', true, false)
      assert.equal(input.value, 'hello worl')
    })

    it('Ctrl+W deletes word backward', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('ctrl_w', '', true, false)
      assert.equal(input.value, 'hello ')
    })
  })

  describe('submit', () => {
    it('calls onSubmit and returns submit event', () => {
      let submitted = ''
      const input = new InputLine({
        value: 'query',
        onSubmit: (v) => { submitted = v },
      })
      const result = input.handleKey('return', '', false, false)
      assert.equal(result?.type, 'submit')
      assert.equal(submitted, 'query')
    })

    it('clears the buffer after submit (no residual text in input box)', () => {
      const input = new InputLine({ value: 'hello world' })
      const result = input.handleKey('return', '', false, false)
      assert.equal(result?.type, 'submit')
      assert.equal(result?.value, 'hello world') // event still carries submitted text
      assert.equal(input.value, '') // but buffer is cleared
      assert.equal(input.cursor, 0)
      // next render shows an empty input line (placeholder), not the sent message
      assert.equal(input.displayLines().length, 1)
      assert.ok(!input.displayLines()[0]?.includes('hello world'))
    })

    it('clears the buffer after vim-normal submit', () => {
      const input = new InputLine({ vimEnabled: true, value: 'sent' })
      input.handleKey('escape', '', false, false) // → normal mode
      const result = input.handleKey('return', '', false, false)
      assert.equal(result?.type, 'submit')
      assert.equal(input.value, '')
      assert.equal(input.cursor, 0)
    })

    it('resets history index after submit so Up starts fresh', () => {
      const input = new InputLine({ history: ['old1', 'old2'] })
      input.handleKey('up', '', false, false) // value = 'old1'
      input.setValue('new query')
      input.handleKey('return', '', false, false)
      assert.equal(input.value, '')
      input.handleKey('up', '', false, false) // should fetch most recent history
      assert.equal(input.value, 'old1')
    })
  })

  describe('history', () => {
    it('navigates history with up/down', () => {
      const input = new InputLine({ history: ['cmd3', 'cmd2', 'cmd1'] })
      input.handleKey('up', '', false, false)
      assert.equal(input.value, 'cmd3')
      input.handleKey('up', '', false, false)
      assert.equal(input.value, 'cmd2')
      input.handleKey('down', '', false, false)
      assert.equal(input.value, 'cmd3')
    })

    it('returns null when no more history', () => {
      assert.equal(new InputLine().handleKey('up', '', false, false), null)
    })
  })

  describe('vim mode', () => {
    it('switches to normal mode on Escape', () => {
      const input = new InputLine({ vimEnabled: true })
      assert.equal(input.vimMode, 'insert')
      input.handleKey('escape', '', false, false)
      assert.equal(input.vimMode, 'normal')
    })

    it('switches to insert mode with i', () => {
      const input = new InputLine({ vimEnabled: true })
      input.handleKey('escape', '', false, false)
      input.handleKey('unknown', 'i', false, false)
      assert.equal(input.vimMode, 'insert')
    })

    it('a moves cursor forward then enters insert', () => {
      const input = new InputLine({ vimEnabled: true, value: 'hello' })
      input.handleKey('escape', '', false, false)
      input.handleKey('left', '', false, false) // cursor from 5 → 4
      input.handleKey('unknown', 'a', false, false)
      assert.equal(input.vimMode, 'insert')
      assert.equal(input.cursor, 5) // 4+1=5
    })

    it('w + D in normal mode', () => {
      const input = new InputLine({ vimEnabled: true, value: 'hello world' })
      input.handleKey('escape', '', false, false)
      input.handleKey('home', '', false, false)
      // 'w' moves to next word start (position 6, 'w' of 'world')
      input.handleKey('unknown', 'w', false, false)
      input.handleKey('unknown', 'D', false, false)
      assert.equal(input.value, 'hello ')
    })

    it('setVimEnabled toggles vim on/off and resets to insert mode', () => {
      const input = new InputLine({ vimEnabled: false })
      assert.equal(input.vimEnabled, false)
      input.setVimEnabled(true)
      assert.equal(input.vimEnabled, true)
      assert.equal(input.vimMode, 'insert', '启用后从 insert 起步')
      input.handleKey('escape', '', false, false)
      assert.equal(input.vimMode, 'normal')
      // 关闭时复位 insert，避免残留 normal 态吞普通字符
      input.setVimEnabled(false)
      assert.equal(input.vimEnabled, false)
      assert.equal(input.vimMode, 'insert', '停用后复位 insert')
    })
  })

  describe('word navigation', () => {
    it('Option+Left moves to previous word start', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('left', '', false, true) // meta+left
      assert.equal(input.cursor, 6)
    })

    it('Option+Right moves to next word end', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('home', '', false, false)
      input.handleKey('right', '', false, true) // meta+right
      assert.equal(input.cursor, 5)
    })

    it('Option+Backspace deletes word backward', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('backspace', '', false, true) // meta+backspace
      assert.equal(input.value, 'hello ')
    })
  })

  describe('maxLength', () => {
    it('caps input at maxLength', () => {
      const input = new InputLine({ maxLength: 5 })
      for (const ch of 'hello world') {
        input.handleKey('unknown', ch, false, false)
      }
      assert.equal(input.value, 'hello')
    })
  })

  describe('setValue', () => {
    it('updates value and cursor from external source', () => {
      const input = new InputLine()
      input.setValue('new text', 3)
      assert.equal(input.value, 'new text')
      assert.equal(input.cursor, 3)
    })
  })
})
