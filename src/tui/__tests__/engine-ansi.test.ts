import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ANSI, cursorUp, cursorDown, cursorForward, cursorBack, cursorTo, fg, bg, color } from '../engine/ansi.js'

describe('ANSI constants', () => {
  it('SAVE_CURSOR is ESC[s', () => {
    assert.equal(ANSI.SAVE_CURSOR, '\x1B[s')
  })

  it('RESTORE_CURSOR is ESC[u', () => {
    assert.equal(ANSI.RESTORE_CURSOR, '\x1B[u')
  })

  it('ERASE_LINE is ESC[2K', () => {
    assert.equal(ANSI.ERASE_LINE, '\x1B[2K')
  })

  it('ALT_SCREEN_ON and OFF are complementary', () => {
    assert.ok(ANSI.ALT_SCREEN_ON.endsWith('h'))
    assert.ok(ANSI.ALT_SCREEN_OFF.endsWith('l'))
    assert.equal(ANSI.ALT_SCREEN_ON.slice(0, -1), ANSI.ALT_SCREEN_OFF.slice(0, -1))
  })

  it('HIDE_CURSOR and SHOW_CURSOR toggle the same CSI', () => {
    assert.equal(ANSI.HIDE_CURSOR.slice(0, -1), ANSI.SHOW_CURSOR.slice(0, -1))
  })

  it('RESET is ESC[0m', () => {
    assert.equal(ANSI.RESET, '\x1B[0m')
  })
})

describe('cursor builders', () => {
  it('cursorUp produces ESC[nA', () => {
    assert.equal(cursorUp(3), '\x1B[3A')
  })

  it('cursorUp clamps to >= 1', () => {
    assert.equal(cursorUp(0), '\x1B[1A')
    assert.equal(cursorUp(-5), '\x1B[1A')
  })

  it('cursorDown produces ESC[nB', () => {
    assert.equal(cursorDown(2), '\x1B[2B')
  })

  it('cursorTo produces ESC[row;colH', () => {
    assert.equal(cursorTo(1, 1), '\x1B[1;1H')
    assert.equal(cursorTo(10, 20), '\x1B[10;20H')
  })

  it('cursorTo clamps to >= 1', () => {
    assert.equal(cursorTo(0, 0), '\x1B[1;1H')
  })
})

describe('SGR color builders', () => {
  it('fg produces truecolor foreground escape', () => {
    const result = fg('#a8e6cf')
    assert.equal(result, '\x1B[38;2;168;230;207m')
  })

  it('fg handles 3-char hex', () => {
    const result = fg('#fff')
    assert.equal(result, '\x1B[38;2;255;255;255m')
  })

  it('fg returns empty string for invalid hex', () => {
    assert.equal(fg('red'), '')
    assert.equal(fg('#xyz'), '')
    assert.equal(fg(''), '')
  })

  it('bg produces truecolor background escape', () => {
    const result = bg('#1e293b')
    assert.equal(result, '\x1B[48;2;30;41;59m')
  })

  it('color wraps text with fg prefix and RESET suffix', () => {
    const result = color('hello', '#ff0000')
    assert.ok(result.startsWith('\x1B[38;2;255;0;0m'))
    assert.ok(result.includes('hello'))
    assert.ok(result.endsWith('\x1B[0m'))
  })

  it('color with bold adds BOLD after fg', () => {
    const result = color('bold', '#ffffff', { bold: true })
    assert.ok(result.includes(ANSI.BOLD))
  })

  it('color with dim adds DIM after fg', () => {
    const result = color('dim', '#ffffff', { dim: true })
    assert.ok(result.includes(ANSI.DIM))
  })
})
