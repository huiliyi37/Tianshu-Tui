import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, setTheme, getActiveThemeName } from '../theme.js'
import type { ThemeName } from '../theme.js'

function isRegistered(name: ThemeName): boolean {
  const prev = getActiveThemeName()
  try {
    setTheme(name)
    const t = getTheme(3)
    return typeof t.primary === 'string' && t.primary.length > 0
  } catch {
    return false
  } finally {
    setTheme(prev)
  }
}

test('gemini theme is registered (setTheme accepts it without throwing)', () => {
  assert.equal(isRegistered('gemini'), true, '`gemini` must be a valid ThemeName and produce a populated theme object')
})

test('gemini theme produces both truecolor (level 3) and fallback (level 0) variants', () => {
  const prev = getActiveThemeName()
  try {
    setTheme('gemini')
    const tc = getTheme(3)
    const fb = getTheme(0)
    assert.ok(tc.primary.startsWith('#'), 'truecolor primary must be a hex string')
    assert.ok(typeof fb.primary === 'string' && fb.primary.length > 0, 'fallback primary must be a non-empty ANSI name')
    assert.notEqual(tc.primary, fb.primary, 'truecolor and fallback must use different color values')
  } finally {
    setTheme(prev)
  }
})

test('gemini truecolor palette matches Gemini-Codex aesthetics specifications', () => {
  const prev = getActiveThemeName()
  try {
    setTheme('gemini')
    const t = getTheme(3) // force truecolor
    assert.equal(t.primary, '#818cf8', 'primary must equal Gemini Indigo: #818cf8')
    assert.equal(t.secondary, '#c084fc', 'secondary must equal Nebula Violet: #c084fc')
    assert.equal(t.success, '#34d399', 'success must equal Aurora Mint: #34d399')
    assert.equal(t.warning, '#fbbf24', 'warning must equal Stellar Amber: #fbbf24')
    assert.equal(t.error, '#f43f5e', 'error must equal Cosmic Rose: #f43f5e')
    // dim 于 2026-07 系统性提亮（原 Nebula Gray #5e617d 深底对比度 <4.5:1 不可读）
    assert.equal(t.dim, '#8b8ea9', 'dim must equal brightened Nebula Gray: #8b8ea9')
    assert.equal(t.pulseQuiet, '#2a2b3d', 'pulseQuiet must equal Space Dark: #2a2b3d')
    assert.equal(t.pulseActive, '#818cf8', 'pulseActive must mirror primary')
    assert.equal(t.pulseAlert, '#f43f5e', 'pulseAlert must mirror error')
    assert.equal(t.userColor, '#e0e7ff', 'userColor must be Luminescent Indigo White: #e0e7ff')
    assert.equal(t.assistantColor, '#c4c9d2', 'assistantColor must be neutral soft grey: #c4c9d2')
    assert.equal(t.muted, '#9497a6', 'muted must be Nebula Gray: #9497a6')
  } finally {
    setTheme(prev)
  }
})

test('gemini fallback uses bright 16-color ANSI palette', () => {
  const prev = getActiveThemeName()
  try {
    setTheme('gemini')
    const t = getTheme(0) // force fallback (16-color)
    assert.equal(t.primary, 'blueBright', 'fallback primary = blueBright')
    assert.equal(t.secondary, 'magentaBright', 'fallback secondary = magentaBright')
    assert.equal(t.success, 'cyanBright', 'fallback success = cyanBright')
    assert.equal(t.warning, 'yellowBright', 'fallback warning = yellowBright')
    assert.equal(t.error, 'redBright', 'fallback error = redBright')
    assert.equal(t.assistantColor, 'white', 'fallback assistantColor = white')
    assert.equal(t.dim, 'gray', 'fallback dim = gray')
    assert.equal(t.pulseQuiet, 'gray', 'fallback pulseQuiet = gray')
    assert.equal(t.pulseActive, 'blueBright', 'fallback pulseActive = blueBright')
    assert.equal(t.pulseAlert, 'redBright', 'fallback pulseAlert = redBright')
  } finally {
    setTheme(prev)
  }
})

test('gemini theme preserves toolColor/contextColor semantic mapping', () => {
  const prev = getActiveThemeName()
  try {
    setTheme('gemini')
    const t = getTheme(3)
    // bash/grep/glob → toolShell (#7dd3fc)
    assert.equal(t.toolColor('bash'), '#7dd3fc')
    assert.equal(t.toolColor('grep'), '#7dd3fc')
    assert.equal(t.toolColor('glob'), '#7dd3fc')
    // edit/write → toolEdit/secondary (#c084fc)
    assert.equal(t.toolColor('edit_file'), '#c084fc')
    assert.equal(t.toolColor('write_file'), '#c084fc')
    // run_tests → toolTest/success (#34d399)
    assert.equal(t.toolColor('run_tests'), '#34d399')
    // delegate → toolDelegate/warning (#fbbf24)
    assert.equal(t.toolColor('delegate_task'), '#fbbf24')
    assert.equal(t.toolColor('delegate_batch'), '#fbbf24')
    // unknown → falls back to toolShell (shared shell/exploration color, same as bash/grep/glob)
    assert.equal(t.toolColor('unknown_tool'), t.toolColor('bash'))
  } finally {
    setTheme(prev)
  }
})
