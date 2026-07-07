import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ANSI, cursorUp, cursorDown, cursorForward, cursorBack, cursorTo, fg, bg, color, rgbToXterm256 } from '../engine/ansi.js'

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

  it('fg maps chalk named colors to basic 16-color SGR', () => {
    assert.equal(fg('red'), '\x1B[31m')
    assert.equal(fg('cyan'), '\x1B[36m')
    assert.equal(fg('gray'), '\x1B[90m')
    assert.equal(fg('redBright'), '\x1B[91m')
  })

  it('bg maps chalk named colors to background SGR (+10)', () => {
    assert.equal(bg('red'), '\x1B[41m')
    assert.equal(bg('gray'), '\x1B[100m')
  })

  it('fg returns empty string for unparseable values', () => {
    assert.equal(fg('#xyz'), '')
    assert.equal(fg(''), '')
    assert.equal(fg('not-a-color'), '')
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

describe('rgbToXterm256 quantization', () => {
  it('maps pure cube corners exactly', () => {
    assert.equal(rgbToXterm256(0, 0, 0), 16)        // cube (0,0,0)
    assert.equal(rgbToXterm256(255, 255, 255), 231) // cube (5,5,5)
    assert.equal(rgbToXterm256(255, 0, 0), 196)     // 16 + 36*5
    assert.equal(rgbToXterm256(0, 255, 0), 46)      // 16 + 6*5
    assert.equal(rgbToXterm256(0, 0, 255), 21)      // 16 + 5
  })

  it('prefers grayscale ramp for near-gray colors', () => {
    const idx = rgbToXterm256(128, 128, 128)
    assert.ok(idx >= 232 && idx <= 255, `mid gray should hit grayscale ramp, got ${idx}`)
  })

  it('maps cube-level values to their exact cube entry', () => {
    // 6 档分量值 0/95/135/175/215/255 —— (95,135,175) = 16 + 36*1 + 6*2 + 3
    assert.equal(rgbToXterm256(95, 135, 175), 16 + 36 * 1 + 6 * 2 + 3)
  })

  it('stays within valid 256-color index range for random samples', () => {
    for (let i = 0; i < 500; i++) {
      const r = (i * 37) % 256, g = (i * 91) % 256, b = (i * 53) % 256
      const idx = rgbToXterm256(r, g, b)
      assert.ok(idx >= 16 && idx <= 255, `index out of range: ${idx}`)
    }
  })
})
