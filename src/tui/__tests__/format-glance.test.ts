import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { formatGlanceBar } from '../format/glance-bar.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatGlanceBar', () => {
  it('renders separator line + status line', () => {
    const result = formatGlanceBar({ width: 80 }, theme)
    const lines = result.split('\n')
    assert.equal(lines.length, 2)
    assert.ok(stripAnsi(lines[0]!).includes('─'.repeat(79)))
    assert.ok(stripAnsi(lines[1]!).includes('天枢'))
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

  it('includes cache hit rate', () => {
    const result = formatGlanceBar({ width: 80, cacheHitRate: 0.75 }, theme)
    assert.ok(stripAnsi(result).includes('75%'))
  })

  it('includes context ratio with color thresholds', () => {
    const normal = formatGlanceBar({ width: 80, contextRatio: 0.5 }, theme)
    // Context ratio uses ANSI color — check for escape sequences in the ratio area
    assert.ok(normal.includes('50%'))

    const high = formatGlanceBar({ width: 80, contextRatio: 0.9 }, theme)
    // High (>88%): should have color applied
    assert.ok(high.includes('90%'))
    assert.ok(/\x1B\[/.test(high), 'has ANSI color for high ratio')
  })

  it('adapts for narrow terminals', () => {
    const narrow = formatGlanceBar({ width: 50, modelName: 'very-long-model-name', contextRatio: 0.5 }, theme)
    // 窄终端应截断模型名到 12 字符
    const plain = stripAnsi(narrow)
    // Model name should be truncated
    assert.ok(!plain.includes('very-long-model-name'))
  })

  it('renders ◧ Xk/Yk token counts when estimatedTokens + maxTokens given', () => {
    const result = formatGlanceBar({ width: 120, estimatedTokens: 12_300, maxTokens: 200_000 }, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('◧'), 'has token glyph')
    assert.ok(plain.includes('12k/200k'), `has Xk/Yk: ${plain}`)
  })

  it('renders 1.0M for 1M-context windows instead of 1000k', () => {
    // 领航星 2026-06-11 实测：1M 窗口原显示 ◧ Xk/1000k 顶到换行临界。
    // 验证: maxTokens=1_000_000 必须显示 "1.0M"，不得出现 "1000k"。
    const result = formatGlanceBar({ width: 140, estimatedTokens: 12_300, maxTokens: 1_000_000 }, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('1.0M'), `1.0M present: ${plain}`)
    assert.ok(!plain.includes('1000k'), `no 1000k artifact: ${plain}`)
  })

  it('renders 2.5M for 2.5M tokens (one decimal under 10M)', () => {
    const result = formatGlanceBar({ width: 140, estimatedTokens: 2_500_000, maxTokens: 4_000_000 }, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('2.5M'), `2.5M present: ${plain}`)
    assert.ok(plain.includes('4.0M'), `4.0M present: ${plain}`)
  })

  it('rounds to integer M for ≥10M tokens (avoid visual width blowup)', () => {
    const result = formatGlanceBar({ width: 140, estimatedTokens: 12_000_000, maxTokens: 32_000_000 }, theme)
    const plain = stripAnsi(result)
    assert.ok(plain.includes('12M'), `12M present: ${plain}`)
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
    const statusLine = result.split('\n')[1]!
    const plain = stripAnsi(statusLine)
    assert.ok(plain.endsWith('1s'), 'elapsed at end of line')
  })

  // ── 防重复渲染回归：状态行显示宽度绝不能 ≥ 终端宽度 ──────────────────
  // 根因：旧 stripAnsiLen 用 .length(JS code units)，CJK(天枢/测试)按 1 计，
  // 实际渲染 2 列 → 行被撑到 width+1 落入末列自动换行临界 → LiveEngine 行数
  // 计算与终端实际换行错位 → clear() 欠擦 → chrome 顶部残留进 scrollback(重复)。
  // 修复后所有 zone 用 display width 度量，状态行严格 ≤ width-1，永不换行。
  it('status line display-width never exceeds terminal width (no wrap → no duplicate)', () => {
    for (const width of [60, 80, 100, 120]) {
      const result = formatGlanceBar({
        width,
        domainGlyph: '⚙', domainName: '天枢', branch: 't9-ui-refactor',
        phaseGlyph: '·', phaseLabel: 'idle', modelName: 'opus-4-8',
        contextRatio: 0, estimatedTokens: 0, maxTokens: 1_000_000,
        cost: 0, elapsedMs: 0, turnCount: 1,
      }, theme)
      const [sepLine, statusLine] = result.split('\n')
      const sepW = stringWidth(stripAnsi(sepLine!))
      const statusW = stringWidth(stripAnsi(statusLine!))
      assert.ok(statusW <= width - 1, `width=${width}: status display-width ${statusW} must be ≤ ${width - 1}`)
      assert.ok(sepW <= width - 1, `width=${width}: separator display-width ${sepW} must be ≤ ${width - 1}`)
    }
  })

  it('status line stays bounded with wide CJK domain names', () => {
    const result = formatGlanceBar({
      width: 80, domainGlyph: '❂', domainName: '天枢测试星域', branch: 'feature/中文分支名',
      phaseGlyph: '◐', phaseLabel: '凝思', modelName: 'claude-opus-4-8',
      contextRatio: 0.5, estimatedTokens: 123_456, maxTokens: 1_000_000,
      cost: 1.23, elapsedMs: 65_000,
    }, theme)
    const statusLine = result.split('\n')[1]!
    const statusW = stringWidth(stripAnsi(statusLine))
    assert.ok(statusW <= 79, `CJK-heavy status display-width ${statusW} must be ≤ 79`)
  })
})
