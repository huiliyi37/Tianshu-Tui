import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatSpinnerStatus,
  formatTokenCount,
  formatTurnWorkSummary,
  formatElapsedHuman,
  phaseIndicator,
} from '../format/spinner-status.js'
import { brailleSpinnerFrame } from '../braille-spinner.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatSpinnerStatus', () => {
  it('idle returns null', () => {
    assert.equal(formatSpinnerStatus({ tick: 0, phase: 'idle', elapsedMs: 0 }, theme), null)
  })

  it('thinking shows braille frame + verb + elapsed + esc hint', () => {
    const line = formatSpinnerStatus({ tick: 3, phase: 'thinking', elapsedMs: 12_000 }, theme)
    assert.ok(line)
    const plain = stripAnsi(line!)
    assert.ok(plain.includes(brailleSpinnerFrame(3)), 'spinner frame matches tick')
    assert.ok(plain.includes('Thinking…'))
    assert.ok(plain.includes('12s'))
    assert.ok(plain.includes('esc to interrupt'))
  })

  it('verb rotates with phase', () => {
    const streaming = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'streaming', elapsedMs: 0 }, theme)!)
    const analyzing = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'analyzing', elapsedMs: 0 }, theme)!)
    const waiting = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'waiting', elapsedMs: 0 }, theme)!)
    assert.ok(streaming.includes('Writing…'))
    assert.ok(analyzing.includes('Working…'))
    assert.ok(waiting.includes('Waiting…'))
  })

  it('spinner frame advances with tick', () => {
    const a = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 0 }, theme)!)
    const b = stripAnsi(formatSpinnerStatus({ tick: 1, phase: 'thinking', elapsedMs: 0 }, theme)!)
    assert.notEqual(a[0], b[0])
  })

  it('stalled and normal produce different output (amber)', () => {
    // 测试环境 theme 可能回退到命名色（fg('') 无 SGR），用 hex theme 验证换色
    const hexTheme = { ...theme, secondary: '#d4a5f5', warning: '#ffdac1' }
    const normal = formatSpinnerStatus({ tick: 0, phase: 'streaming', elapsedMs: 5000 }, hexTheme)!
    const stalled = formatSpinnerStatus({ tick: 0, phase: 'streaming', elapsedMs: 5000, stalled: true }, hexTheme)!
    assert.equal(stripAnsi(normal), stripAnsi(stalled), 'same text')
    assert.notEqual(normal, stalled, 'different color')
  })

  it('elapsed over a minute renders Xm Ys', () => {
    const line = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 66_000 }, theme)!)
    assert.ok(line.includes('1m 6s'))
  })
})

describe('formatElapsedHuman / formatTokenCount', () => {
  it('formats sub-minute and minute elapsed', () => {
    assert.equal(formatElapsedHuman(9_500), '9s')
    assert.equal(formatElapsedHuman(66_000), '1m 6s')
  })

  it('formats token counts', () => {
    assert.equal(formatTokenCount(890), '890')
    assert.equal(formatTokenCount(12_300), '12.3k')
    assert.equal(formatTokenCount(1_200_000), '1.20M')
  })
})

describe('formatTurnWorkSummary', () => {
  it('renders ✦ Worked for … · in/out tokens', () => {
    const line = stripAnsi(formatTurnWorkSummary({
      elapsedMs: 66_000,
      inputTokens: 12_300,
      outputTokens: 890,
    }, theme))
    assert.ok(line.includes('✦ Worked for 1m 6s'))
    assert.ok(line.includes('12.3k in / 890 out'))
  })
})

describe('phaseIndicator', () => {
  it('maps each phase to glyph + label', () => {
    assert.deepEqual(phaseIndicator('thinking'), { glyph: '◐', label: 'thinking' })
    assert.deepEqual(phaseIndicator('streaming'), { glyph: '✦', label: 'writing' })
    assert.deepEqual(phaseIndicator('analyzing'), { glyph: '⚙', label: 'tools' })
    assert.deepEqual(phaseIndicator('idle'), { glyph: '·', label: 'idle' })
  })
})
