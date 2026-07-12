import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { formatGlanceBar, formatGlanceRight, formatPermissionModeLine } from '../format/glance-bar.js'
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

  it('renders reasoning effort badge (◎ + tier, medium abbreviated to med)', () => {
    const maxBar = stripAnsi(formatGlanceBar({ width: 120, reasoningEffort: 'max' }, theme))
    assert.ok(maxBar.includes('◎max'), `expected ◎max in: ${maxBar}`)
    const medBar = stripAnsi(formatGlanceBar({ width: 120, reasoningEffort: 'medium' }, theme))
    assert.ok(medBar.includes('◎med'), `expected ◎med in: ${medBar}`)
    const noEffort = stripAnsi(formatGlanceBar({ width: 120 }, theme))
    assert.ok(!noEffort.includes('◎'), 'no effort badge when undefined')
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

describe('formatGlanceRight density（Wave 2 减密分档）', () => {
  const fullInput = {
    width: 120,
    modelName: 'deepseek-v4',
    reasoningEffort: 'high',
    cacheHitRate: 0.8,
    estimatedTokens: 50_000,
    conversationTokens: 30_000,
    maxTokens: 200_000,
    cost: 1.23,
    elapsedMs: 65_000,
    approvalMode: 'auto-safe',
    todoSummary: { total: 5, done: 2, inProgress: 1, current: '修复主题' },
  }

  it('compact 档保留模型 + effort + cache% + 上下文% + 耗时（权限 badge/todo/cost 收起）', () => {
    const plain = stripAnsi(formatGlanceRight({ ...fullInput, density: 'compact' }, theme))
    assert.ok(!plain.includes('[safe]'), '权限 badge 不再出现在 GlanceBar')
    assert.ok(plain.includes('deepseek-v4'), '模型保留')
    assert.ok(plain.includes('◎high'), 'effort 保留')
    assert.ok(plain.includes('⚡80%'), 'cache 命中率保留')
    assert.ok(plain.includes('◧25%'), `上下文百分比保留: ${plain}`)
    assert.ok(plain.includes('1m5s'), '耗时保留')
    assert.ok(!plain.includes('¥'), 'cost 收起')
    assert.ok(!plain.includes('☐'), 'todo 收起')
    assert.ok(!plain.includes('50k'), 'token 绝对值收起（只留百分比）')
  })

  it('full 档（默认，density 未传）保留全量信息', () => {
    const plain = stripAnsi(formatGlanceRight(fullInput, theme))
    assert.ok(plain.includes('⚡80%'), 'cache 显示')
    assert.ok(plain.includes('¥1.23'), 'cost 显示')
    assert.ok(plain.includes('◎high'), 'effort 显示')
    assert.ok(plain.includes('☐ 2/5'), 'todo 显示')
  })

  it('compact 档缺 token 数据时不渲染 ◧', () => {
    const plain = stripAnsi(formatGlanceRight({ width: 120, density: 'compact', modelName: 'm', elapsedMs: 1000 }, theme))
    assert.ok(!plain.includes('◧'))
  })
})

describe('formatPermissionModeLine（输入框下方权限模式行，CC parity）', () => {
  it('默认 auto-safe，含 shift+tab 提示', () => {
    const plain = stripAnsi(formatPermissionModeLine({}, theme))
    assert.ok(plain.includes('⏵ auto-safe'), `should show auto-safe: ${plain}`)
    assert.ok(plain.includes('shift+tab'), 'should hint cycle key')
  })

  it('plan mode 优先于权限模式，含 shift+tab 提示', () => {
    const plain = stripAnsi(formatPermissionModeLine({ approvalMode: 'manual', planMode: true }, theme))
    assert.ok(plain.includes('⏵ plan mode'), `plan mode wins: ${plain}`)
    assert.ok(plain.includes('shift+tab'), 'should hint cycle key')
    assert.ok(!plain.includes('manual'))
  })

  it('plan mode 可附带草稿路径', () => {
    const plain = stripAnsi(formatPermissionModeLine({
      planMode: true,
      planDraftPath: '.rivet/plans/draft-1.md',
    }, theme))
    assert.ok(plain.includes('draft-1.md'), `draft path: ${plain}`)
  })

  it('yolo 模式显示缩写标签', () => {
    const plain = stripAnsi(formatPermissionModeLine({ approvalMode: 'dangerously-skip-permissions' }, theme))
    assert.ok(plain.includes('⏵ yolo'), `should abbreviate: ${plain}`)
  })

  it('manual 模式原样显示', () => {
    const plain = stripAnsi(formatPermissionModeLine({ approvalMode: 'manual' }, theme))
    assert.ok(plain.includes('⏵ manual'))
  })
})
