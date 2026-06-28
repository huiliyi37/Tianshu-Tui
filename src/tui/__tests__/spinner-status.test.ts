import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import chalk from 'chalk'
import {
  formatSpinnerStatus,
  formatTokenCount,
  formatTurnWorkSummary,
  formatElapsedHuman,
} from '../format/spinner-status.js'
import { circleSpinnerFrame } from '../braille-spinner.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatSpinnerStatus', () => {
  it('idle returns null', () => {
    assert.equal(formatSpinnerStatus({ tick: 0, phase: 'idle', elapsedMs: 0 }, theme), null)
  })

  it('shows single spinner frame + static word + elapsed', () => {
    const line = formatSpinnerStatus({ tick: 3, phase: 'thinking', elapsedMs: 12_000 }, theme)
    assert.ok(line)
    const plain = stripAnsi(line!)
    const useAscii = chalk.level < 3
    const expectedFrame = useAscii ? '/' : circleSpinnerFrame(3)
    assert.ok(plain.startsWith(expectedFrame), 'leads with single spinner frame matching tick')
    assert.ok(plain.includes('thinking'), 'word is the static label')
    assert.ok(plain.includes('…'), 'word carries ellipsis')
    assert.ok(plain.includes('12s'))
    assert.ok(!plain.includes('esc'), 'no interrupt hint appended')
  })

  it('spinner label reflects phase (all non-idle unified to thinking)', () => {
    const thinking = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'thinking', elapsedMs: 0 }, theme)!)
    const streaming = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'streaming', elapsedMs: 0 }, theme)!)
    const analyzing = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'analyzing', elapsedMs: 0 }, theme)!)
    const waiting = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'waiting', elapsedMs: 0 }, theme)!)
    assert.ok(thinking.includes('thinking'))
    assert.ok(streaming.includes('thinking'))
    assert.ok(analyzing.includes('thinking'))
    assert.ok(waiting.includes('thinking'))
  })

  it('word is static (does not rotate with elapsed)', () => {
    const early = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 0 }, theme)!)
    const later = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 12_000 }, theme)!)
    // 仅词区域（'…' 之前）应保持不变——elapsed 部分本就该随时间走。
    assert.equal(early.split('…')[0], later.split('…')[0], 'word region is identical regardless of elapsed')
    assert.ok(early.includes('thinking'), 'uses static English "thinking" word')
    assert.ok(!/[\u4e00-\u9fff]/.test(early), 'no Chinese characters leaked into output')
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
  it('renders ◆ elapsed · in→out tokens', () => {
    const line = stripAnsi(formatTurnWorkSummary({
      elapsedMs: 66_000,
      inputTokens: 12_300,
      outputTokens: 890,
    }, theme))
    const useAscii = chalk.level < 3
    const expectedGlyph = useAscii ? 'Y' : '◆'
    assert.ok(line.includes(`${expectedGlyph} 1m 6s`))
    assert.ok(line.includes('12.3k→890'))
  })
})

