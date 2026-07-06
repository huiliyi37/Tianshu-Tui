/**
 * Wave 1 主题系统架构测试：
 * - palette 完整性快照（每套主题双轨全 token）
 * - 亮色主题元数据与对比度基线
 * - 自定义主题注册/解析/回退
 * - auto 检测的纯函数部分（OSC 11 解析 + COLORFGBG 兜底）
 * - 256 色量化接线（getTheme(2) 走 truecolor 轨）
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  THEMES, THEME_NAMES, getTheme, setTheme, getActiveThemeName,
  getActiveThemeBackground, registerCustomTheme, listCustomThemes,
  clearCustomThemes, resolveThemeEntry,
} from '../theme.js'
import { THEME_PALETTES } from '../theme-palettes.js'
import { parseOsc11Luminance, parseColorFgBg, autoThemeFor } from '../theme-detect.js'
import { parseCustomThemeJson, loadCustomThemes } from '../theme-custom.js'

afterEach(() => {
  setTheme('cobalt')
  clearCustomThemes()
})

const HEX_RE = /^#[0-9a-fA-F]{6}$/
const SEMANTIC_KEYS = [
  'primary', 'secondary', 'success', 'warning', 'error', 'dim', 'muted',
  'pulseQuiet', 'pulseActive', 'pulseAlert', 'userColor', 'assistantColor', 'systemColor',
] as const

describe('palette completeness snapshot', () => {
  it('every theme has all semantic tokens on both rails', () => {
    for (const name of THEME_NAMES) {
      const entry = THEMES[name]
      for (const key of SEMANTIC_KEYS) {
        const tc = entry.truecolor[key]
        const fb = entry.fallback[key]
        assert.equal(typeof tc, 'string', `${name}.truecolor.${key}`)
        assert.ok(tc.length > 0, `${name}.truecolor.${key} empty`)
        assert.ok(HEX_RE.test(tc), `${name}.truecolor.${key} must be 6-digit hex, got ${tc}`)
        assert.equal(typeof fb, 'string', `${name}.fallback.${key}`)
        assert.ok(fb.length > 0, `${name}.fallback.${key} empty`)
      }
      assert.ok(entry.background === 'dark' || entry.background === 'light', `${name}.background`)
      assert.ok(entry.description.length > 0, `${name}.description`)
    }
  })

  it('THEME_NAMES matches THEME_PALETTES keys and includes light themes', () => {
    assert.deepEqual(new Set(THEME_NAMES), new Set(Object.keys(THEME_PALETTES)))
    assert.ok(THEME_NAMES.includes('paper'))
    assert.ok(THEME_NAMES.includes('light-ansi'))
  })
})

/** WCAG 相对亮度。 */
function luminance(hex: string): number {
  const c = [1, 3, 5].map(i => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}

function contrastOnWhite(hex: string): number {
  return (1.0 + 0.05) / (luminance(hex) + 0.05)
}

describe('light theme contrast baseline', () => {
  it('paper/light-ansi are tagged light; all dark themes tagged dark', () => {
    assert.equal(THEMES.paper.background, 'light')
    assert.equal(THEMES['light-ansi'].background, 'light')
    assert.equal(THEMES.cobalt.background, 'dark')
    assert.equal(THEMES.tianshu.background, 'dark')
  })

  it('light themes: dim/muted/semantic colors readable on white (>= 3:1)', () => {
    for (const name of ['paper', 'light-ansi'] as const) {
      const t = THEMES[name].truecolor
      for (const key of ['primary', 'secondary', 'success', 'warning', 'error', 'dim', 'muted', 'assistantColor', 'userColor'] as const) {
        const ratio = contrastOnWhite(t[key])
        assert.ok(ratio >= 3, `${name}.${key} contrast on white = ${ratio.toFixed(2)} < 3`)
      }
    }
  })
})

describe('custom themes', () => {
  it('registerCustomTheme inherits base and applies overrides', () => {
    registerCustomTheme('mytheme', {
      base: 'cobalt',
      colors: { primary: '#ff8800' },
      overrides: { userColor: '#ffffff' },
      description: 'test theme',
    })
    assert.deepEqual(listCustomThemes(), ['mytheme'])
    const entry = resolveThemeEntry('custom:mytheme')
    assert.ok(entry)
    assert.equal(entry.truecolor.primary, '#ff8800')
    assert.equal(entry.truecolor.userColor, '#ffffff')
    // 未覆盖 token 继承 cobalt
    assert.equal(entry.truecolor.success, THEMES.cobalt.truecolor.success)
    assert.equal(entry.description, 'test theme')
  })

  it('setTheme accepts custom: names and unknown names are no-ops', () => {
    registerCustomTheme('neon', { colors: { primary: '#00ff00' } })
    assert.equal(setTheme('custom:neon'), true)
    assert.equal(getActiveThemeName(), 'custom:neon')
    assert.equal(getTheme(3).primary, '#00ff00')
    // 未知名 no-op：活动主题不变
    assert.equal(setTheme('custom:missing'), false)
    assert.equal(getActiveThemeName(), 'custom:neon')
  })

  it('light custom theme defaults to paper base', () => {
    registerCustomTheme('sun', { background: 'light' })
    const entry = resolveThemeEntry('custom:sun')!
    assert.equal(entry.background, 'light')
    assert.equal(entry.truecolor.primary, THEMES.paper.truecolor.primary)
  })

  it('parseCustomThemeJson validates hex and drops junk fields', () => {
    const parsed = parseCustomThemeJson(JSON.stringify({
      base: 'slate',
      colors: { primary: '#123456', secondary: 'not-hex', bogus: '#ffffff' },
      overrides: { userColor: '#abc' },
    }))!
    assert.equal(parsed.base, 'slate')
    assert.deepEqual(parsed.colors, { primary: '#123456' })
    assert.deepEqual(parsed.overrides, { userColor: '#abc' })
    assert.equal(parseCustomThemeJson('not json'), null)
    assert.equal(parseCustomThemeJson('42'), null)
  })

  it('loadCustomThemes scans dir, skips invalid files, registers valid ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-themes-'))
    try {
      mkdirSync(join(dir, 'themes'), { recursive: true })
      writeFileSync(join(dir, 'themes', 'good.json'), JSON.stringify({ colors: { primary: '#aa00aa' } }))
      writeFileSync(join(dir, 'themes', 'broken.json'), '{{{')
      writeFileSync(join(dir, 'themes', 'bad name!.json'), '{}')
      const loaded = loadCustomThemes(dir)
      assert.deepEqual(loaded, ['good'])
      assert.equal(resolveThemeEntry('custom:good')?.truecolor.primary, '#aa00aa')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loadCustomThemes returns [] when dir missing', () => {
    assert.deepEqual(loadCustomThemes(join(tmpdir(), 'rivet-definitely-missing-dir')), [])
  })
})

describe('auto theme detection helpers', () => {
  it('parseOsc11Luminance reads rgb payloads', () => {
    const dark = parseOsc11Luminance('\x1B]11;rgb:0000/0000/0000\x07')
    const light = parseOsc11Luminance('\x1B]11;rgb:ffff/ffff/ffff\x07')
    assert.ok(dark !== null && dark < 0.1)
    assert.ok(light !== null && light > 0.9)
    // 2 位分量（部分终端）
    const mid = parseOsc11Luminance('\x1B]11;rgb:dc/dc/dc\x1B\\')
    assert.ok(mid !== null && mid > 0.7)
    assert.equal(parseOsc11Luminance('garbage'), null)
  })

  it('parseColorFgBg maps bg index 7/15 to light, others dark', () => {
    assert.equal(parseColorFgBg('0;15'), 'light')
    assert.equal(parseColorFgBg('15;0'), 'dark')
    assert.equal(parseColorFgBg('12;8'), 'dark')
    assert.equal(parseColorFgBg('default;7'), 'light')
    assert.equal(parseColorFgBg(undefined), null)
    assert.equal(parseColorFgBg('junk'), null)
  })

  it('autoThemeFor picks cobalt for dark, paper for light', () => {
    assert.equal(autoThemeFor('dark'), 'cobalt')
    assert.equal(autoThemeFor('light'), 'paper')
  })
})

describe('color level rails', () => {
  it('getTheme(2) uses truecolor rail (quantized at render time by ansi.ts)', () => {
    setTheme('cobalt')
    assert.equal(getTheme(2).primary, '#6ab8ff')
  })

  it('getTheme(1)/getTheme(0) use named-color fallback rail', () => {
    setTheme('cobalt')
    assert.equal(getTheme(1).primary, 'blue')
    assert.equal(getTheme(0).primary, 'blue')
  })

  it('getActiveThemeBackground follows the active theme', () => {
    setTheme('paper')
    assert.equal(getActiveThemeBackground(), 'light')
    setTheme('cobalt')
    assert.equal(getActiveThemeBackground(), 'dark')
  })
})
