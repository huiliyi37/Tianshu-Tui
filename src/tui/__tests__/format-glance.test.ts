import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { formatGlanceBar, formatGlanceBarDual, formatTokenProgressBar } from '../format/glance-bar.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatGlanceBar', () => {
  it('renders single status line without separator', () => {
    const result = formatGlanceBar({ width: 80 }, theme)
    const lines = result.split('\n')
    assert.equal(lines.length, 1)
    assert.ok(stripAnsi(lines[0]!).includes('天枢'))
  })

  it('includes domain glyph and name', () => {
    const result = formatGlanceBar({ width: 80, domainGlyph: '⭐', domainName: '测试' }, theme)
    assert.ok(stripAnsi(result).includes('⭐'))
    assert.ok(stripAnsi(result).includes('测试'))
  })

  it('includes model name', () => {
    const result = formatGlanceBar({ width: 80, modelName: 'deepseek-v4' }, theme)
    assert.ok(stripAnsi(result).includes('deepseek-v4'))
  })

  it('includes elapsed time', () => {
    const result = formatGlanceBar({ width: 80, elapsedMs: 125_000 }, theme)
    assert.ok(stripAnsi(result).includes('2m5s'))
  })

  it('cache hit rate always shown, colored by health (< 50% warning, ≥ 50% dim)', () => {
    const low = formatGlanceBar({ width: 80, cacheHitRate: 0.3 }, theme)
    assert.ok(stripAnsi(low).includes('30%'), 'cache < 50% should show')
    const high = formatGlanceBar({ width: 80, cacheHitRate: 0.75 }, theme)
    assert.ok(stripAnsi(high).includes('75%'), 'cache >= 50% should also show (persistent display)')
  })

  it('tokens 常驻：即便 < 75% 也显示（G7 token/cost 常显）', () => {
    const normal = formatGlanceBar({ width: 120, estimatedTokens: 50_000, maxTokens: 200_000 }, theme)
    assert.ok(stripAnsi(normal).includes('◧'), 'token ratio < 75% 仍常驻显示')
    assert.ok(stripAnsi(normal).includes('50k/200k'))
    const high = formatGlanceBar({ width: 120, estimatedTokens: 160_000, maxTokens: 200_000 }, theme)
    assert.ok(stripAnsi(high).includes('◧'), 'token ratio >= 75% should show')
  })

  it('token 阈值色：<75% dim、≥75% warning、≥90% error', () => {
    // 强制 hex theme（test 环境默认回退命名色无 truecolor SGR）
    const hexTheme = { ...theme, dim: '#5b6270', warning: '#d6a35c', error: '#e08891' }
    const mid = formatGlanceBar({ width: 120, estimatedTokens: 50_000, maxTokens: 200_000 }, hexTheme)
    const warn = formatGlanceBar({ width: 120, estimatedTokens: 160_000, maxTokens: 200_000 }, hexTheme)
    const err = formatGlanceBar({ width: 120, estimatedTokens: 190_000, maxTokens: 200_000 }, hexTheme)
    assert.ok(mid.includes('38;2;91;98;112'), '25% → dim(#5b6270)')
    assert.ok(warn.includes('38;2;214;163;92'), '80% → warning(#d6a35c)')
    assert.ok(err.includes('38;2;224;136;145'), '95% → error(#e08891)')
  })

  it('窄终端降级：tokens 隐藏', () => {
    const narrow = formatGlanceBar({ width: 50, narrow: true, estimatedTokens: 50_000, maxTokens: 200_000 }, theme)
    assert.ok(!stripAnsi(narrow).includes('◧'), '窄终端隐藏 tokens')
  })

  it('adapts for narrow terminals', () => {
    const narrow = formatGlanceBar({ width: 50, modelName: 'very-long-model-name', contextRatio: 0.5 }, theme)
    // 窄终端应截断模型名到 12 字符
    const plain = stripAnsi(narrow)
    // Model name should be truncated
    assert.ok(!plain.includes('very-long-model-name'))
  })

  it('renders ◧ Xk/Yk token counts when estimatedTokens + maxTokens given', () => {
    const result = formatGlanceBar({ width: 120, estimatedTokens: 160_000, maxTokens: 200_000 }, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('◧'), 'has token glyph when ratio >= 75%')
    assert.ok(plain.includes('160k/200k'), `has Xk/Yk: ${plain}`)
  })

  it('renders 1.0M for 1M-context windows instead of 1000k', () => {
    const result = formatGlanceBar({ width: 140, estimatedTokens: 800_000, maxTokens: 1_000_000 }, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('1.0M'), `1.0M present: ${plain}`)
    assert.ok(!plain.includes('1000k'), `no 1000k artifact: ${plain}`)
  })

  it('renders 2.5M for 2.5M tokens (one decimal under 10M)', () => {
    const result = formatGlanceBar({ width: 140, estimatedTokens: 3_200_000, maxTokens: 4_000_000 }, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('3.2M'), `3.2M present: ${plain}`)
    assert.ok(plain.includes('4.0M'), `4.0M present: ${plain}`)
  })

  it('rounds to integer M for ≥10M tokens (avoid visual width blowup)', () => {
    const result = formatGlanceBar({ width: 140, estimatedTokens: 25_000_000, maxTokens: 32_000_000 }, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('25M'), `25M present: ${plain}`)
    assert.ok(plain.includes('32M'), `32M present: ${plain}`)
  })

  it('omits ◧ token counts when maxTokens is missing or zero', () => {
    const noMax = stripAnsi(formatGlanceBar({ width: 120, estimatedTokens: 12_300 }, theme))
    assert.ok(!noMax.includes('◧'))
    const zeroMax = stripAnsi(formatGlanceBar({ width: 120, estimatedTokens: 12_300, maxTokens: 0 }, theme))
    assert.ok(!zeroMax.includes('◧'))
  })

  it('right-pads elapsed to fill width', () => {
    const result = formatGlanceBar({ width: 80, elapsedMs: 1000 }, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.endsWith('1s'), 'elapsed at end of line')
  })

  it('status line display-width never exceeds terminal width (no wrap → no duplicate)', () => {
    for (const width of [60, 80, 100, 120]) {
      const result = formatGlanceBar({
        width,
        domainGlyph: '⚙', domainName: '天枢', branch: 't9-ui-refactor',
        modelName: 'opus-4-8',
        contextRatio: 0, estimatedTokens: 0, maxTokens: 1_000_000,
        cost: 0, elapsedMs: 0, turnCount: 1,
      }, theme)
      const statusW = stringWidth(stripAnsi(result))
      assert.ok(statusW <= width - 1, `width=${width}: status display-width ${statusW} must be ≤ ${width - 1}`)
    }
  })

  it('status line stays bounded with wide CJK domain names', () => {
    const result = formatGlanceBar({
      width: 80, domainGlyph: '❂', domainName: '天枢测试星域', branch: 'feature/中文分支名',
      modelName: 'claude-opus-4-8',
      contextRatio: 0.5, estimatedTokens: 123_456, maxTokens: 1_000_000,
      cost: 1.23, elapsedMs: 65_000,
    }, theme)
    const statusW = stringWidth(stripAnsi(result))
    assert.ok(statusW <= 79, `CJK-heavy status display-width ${statusW} must be ≤ 79`)
  })
})

describe('formatTokenProgressBar', () => {
  it('renders empty bar at 0%', () => {
    const result = formatTokenProgressBar(0, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('0%'))
    assert.ok(plain.includes('░░░░░░░░░░'))
  })

  it('renders full bar at 100%', () => {
    const result = formatTokenProgressBar(1, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('100%'))
  })

  it('renders half bar at 50%', () => {
    const result = formatTokenProgressBar(0.5, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('50%'))
  })

  it('clamps out-of-range values', () => {
    const low = formatTokenProgressBar(-0.5, theme)
    assert.ok(stripAnsi(low).includes('0%'), 'negative ratio clamped to 0')
    const high = formatTokenProgressBar(2.0, theme)
    assert.ok(stripAnsi(high).includes('100%'), 'over-1 ratio clamped to 1')
  })

  it('colors warning at >=75% and error at >=90%', () => {
    const hex = { ...theme, dim: '#5b6270', warning: '#d6a35c', error: '#e08891' }
    const norm = formatTokenProgressBar(0.3, hex)
    const warn = formatTokenProgressBar(0.75, hex)
    const err = formatTokenProgressBar(0.95, hex)
    assert.ok(norm.includes('38;2;91;98;112'), '30% → dim')
    assert.ok(warn.includes('38;2;214;163;92'), '75% → warning')
    assert.ok(err.includes('38;2;224;136;145'), '95% → error')
  })
})

describe('formatGlanceBarDual', () => {
  it('returns exactly two lines', () => {
    const [l1, l2] = formatGlanceBarDual({
      width: 80,
      domainGlyph: '◇', domainName: '天枢', branch: 'main',
      modelName: 'deepseek-chat',
      estimatedTokens: 24_000, maxTokens: 128_000,
      cacheHitRate: 0.72, cost: 0.04, elapsedMs: 32_000, turnCount: 12,
    }, theme)
    assert.ok(l1)
    assert.ok(l2)
    const p1 = stripAnsi(l1)
    const p2 = stripAnsi(l2)
    assert.ok(p1.includes('天枢'))
    assert.ok(p1.includes('main'))
    assert.ok(p1.includes('deepseek-chat'))
    assert.ok(p2.includes('72%'), `cache in line2: ${p2}`)
    assert.ok(p2.includes('0.04'), `cost in line2: ${p2}`)
    assert.ok(p2.includes('12'), `turn in line2: ${p2}`)
    assert.ok(p2.includes('32s'), `elapsed in line2: ${p2}`)
  })

  it('omits optional fields gracefully', () => {
    const [l1, l2] = formatGlanceBarDual({ width: 80 }, theme)
    const p2 = stripAnsi(l2)
    assert.ok(!p2.includes('undefined'), 'no undefined in output')
  })

  it('line width stays bounded at target terminal width', () => {
    for (const w of [60, 80, 99]) {
      const [l1, l2] = formatGlanceBarDual({
        width: w,
        domainGlyph: '◇', domainName: '天枢', branch: 't9-ui-refactor',
        modelName: 'claude-opus-4-8',
        estimatedTokens: 80_000, maxTokens: 1_000_000,
        cacheHitRate: 0.55, cost: 1.23, elapsedMs: 65_000, turnCount: 42,
      }, theme)
      assert.ok(stringWidth(stripAnsi(l1)) <= w, `width=${w}: line1 bounded`)
      assert.ok(stringWidth(stripAnsi(l2)) <= w, `width=${w}: line2 bounded`)
    }
  })

  it('token progress bar present when tokens given', () => {
    const [, l2] = formatGlanceBarDual({
      width: 80, estimatedTokens: 64_000, maxTokens: 128_000,
    }, theme)
    assert.ok(stripAnsi(l2).includes('50%'), 'token bar shows 50%')
  })

  it('token bar omitted when maxTokens missing', () => {
    const [, l2] = formatGlanceBarDual({
      width: 80, estimatedTokens: 64_000,
    }, theme)
    const p = stripAnsi(l2)
    assert.ok(!p.includes('▅'), 'no bar chars when no maxTokens')
    assert.ok(!p.includes('░'), 'no bar chars when no maxTokens')
  })
})
