import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import chalk from 'chalk'
import {
  formatSpinnerStatus,
  formatTokenCount,
  formatTurnWorkSummary,
  formatElapsedHuman,
  configureSpinnerVerbs,
  setReducedMotion,
  resetSpinnerConfig,
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

  it('shows single spinner frame + verb + elapsed', () => {
    resetSpinnerConfig()
    const line = formatSpinnerStatus({ tick: 3, phase: 'thinking', elapsedMs: 5_000 }, theme)
    assert.ok(line)
    const plain = stripAnsi(line!)
    const useAscii = chalk.level < 3
    const expectedFrame = useAscii ? '/' : circleSpinnerFrame(3)
    assert.ok(plain.startsWith(expectedFrame), 'leads with single spinner frame matching tick')
    assert.ok(plain.includes('thinking'), 'first verb slot is "thinking"')
    assert.ok(plain.includes('…'), 'word carries ellipsis')
    assert.ok(plain.includes('5s'))
    assert.ok(!plain.includes('esc'), 'no interrupt hint appended')
  })

  it('verb slot is shared across phases (all non-idle use the pool)', () => {
    resetSpinnerConfig()
    const thinking = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'thinking', elapsedMs: 0 }, theme)!)
    const streaming = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'streaming', elapsedMs: 0 }, theme)!)
    const analyzing = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'analyzing', elapsedMs: 0 }, theme)!)
    const waiting = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'waiting', elapsedMs: 0 }, theme)!)
    assert.ok(thinking.includes('thinking'))
    assert.ok(streaming.includes('thinking'))
    assert.ok(analyzing.includes('thinking'))
    assert.ok(waiting.includes('thinking'))
  })

  it('verb rotates by elapsed time slice (8s per verb), stable within a slice', () => {
    resetSpinnerConfig()
    const early = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 0 }, theme)!)
    const sameSlice = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 7_000 }, theme)!)
    const nextSlice = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 9_000 }, theme)!)
    assert.equal(early.split('…')[0], sameSlice.split('…')[0], 'same verb inside one 8s slice')
    assert.notEqual(early.split('…')[0], nextSlice.split('…')[0], 'verb rotates after slice boundary')
  })

  it('configureSpinnerVerbs replace/append modes', () => {
    configureSpinnerVerbs(['酝酿中'], 'replace')
    const line = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 60_000 }, theme)!)
    assert.ok(line.includes('酝酿中'), 'replaced pool has a single verb regardless of elapsed')
    configureSpinnerVerbs(['自定义词'], 'append')
    const appended = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 0 }, theme)!)
    assert.ok(appended.includes('thinking'), 'append keeps default pool head')
    resetSpinnerConfig()
  })

  it('reducedMotion freezes frame and verb', () => {
    setReducedMotion(true)
    const a = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 0 }, theme)!)
    const b = stripAnsi(formatSpinnerStatus({ tick: 7, phase: 'thinking', elapsedMs: 20_000 }, theme)!)
    assert.equal(a[0], b[0], 'frame is static regardless of tick')
    assert.equal(a.split('…')[0], b.split('…')[0], 'verb is frozen regardless of elapsed')
    resetSpinnerConfig()
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

