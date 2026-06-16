import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, setTheme, getActiveThemeName } from '../theme.js'
import type { ThemeName } from '../theme.js'

// Reverse-derive: if `claude` is registered, setTheme will not throw and getTheme()
// will return a non-empty object. We test registration via behavior, not export.
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

test('claude theme is registered (setTheme accepts it without throwing)', () => {
  assert.equal(isRegistered('claude'), true, '`claude` must be a valid ThemeName and produce a populated theme object')
})

test('claude theme produces both truecolor (level 3) and fallback (level 0) variants', () => {
  setTheme('claude')
  const tc = getTheme(3)
  const fb = getTheme(0)
  assert.ok(tc.primary.startsWith('#'), 'truecolor primary must be a hex string')
  assert.ok(typeof fb.primary === 'string' && fb.primary.length > 0, 'fallback primary must be a non-empty ANSI name')
  // truecolor and fallback should differ — guard against the trivial "only one variant" implementation
  assert.notEqual(tc.primary, fb.primary, 'truecolor and fallback must use different color values')
})

test('claude truecolor palette mirrors Claude Code darkTheme RGB values', () => {
  setTheme('claude')
  const t = getTheme(3) // force truecolor
  assert.equal(t.primary, '#d77757', 'primary must equal Claude Code claude: rgb(215,119,87)')
  assert.equal(t.secondary, '#af87ff', 'secondary must equal Claude Code autoAccept: rgb(175,135,255)')
  assert.equal(t.success, '#4eba65', 'success must equal Claude Code success: rgb(78,186,101)')
  assert.equal(t.warning, '#ffc107', 'warning must equal Claude Code warning: rgb(255,193,7)')
  assert.equal(t.error, '#ff6b80', 'error must equal Claude Code error: rgb(255,107,128)')
  assert.equal(t.dim, '#505050', 'dim must equal Claude Code subtle: rgb(80,80,80)')
  assert.equal(t.pulseQuiet, '#888888', 'pulseQuiet must equal Claude Code promptBorder: rgb(136,136,136)')
  assert.equal(t.pulseActive, '#d77757', 'pulseActive must mirror primary (Claude brand orange)')
  assert.equal(t.pulseAlert, '#ff6b80', 'pulseAlert must mirror error')
  // assistantColor = neutral gray-white (Claude text rgb(217,217,217)), NOT violet —
  // violet is a small badge in upstream; full-body violet clashed with amber tools.
  assert.equal(t.assistantColor, '#d9d9d9', 'assistantColor must be Claude text neutral gray, not violet')
})

test('claude fallback uses dark-ansi 16-color palette (ANSI改造 alignment)', () => {
  setTheme('claude')
  const t = getTheme(0) // force fallback (16-color)
  // dark-ansi mapping from Claude Code
  assert.equal(t.primary, 'redBright', 'fallback primary = redBright (matches darkAnsiTheme.claude)')
  assert.equal(t.secondary, 'magentaBright', 'fallback secondary = magentaBright (autoAccept)')
  assert.equal(t.success, 'greenBright', 'fallback success = greenBright')
  assert.equal(t.warning, 'yellowBright', 'fallback warning = yellowBright')
  assert.equal(t.error, 'redBright', 'fallback error = redBright')
  assert.equal(t.assistantColor, 'white', 'fallback assistantColor = white (neutral, not magentaBright)')
  assert.equal(t.dim, 'white', 'fallback dim = white (subtle: ansi:white in dark-ansi)')
  assert.equal(t.pulseQuiet, 'white', 'fallback pulseQuiet = white (promptBorder)')
  assert.equal(t.pulseActive, 'redBright', 'fallback pulseActive = redBright')
  assert.equal(t.pulseAlert, 'redBright', 'fallback pulseAlert = redBright')
})

test('claude theme preserves toolColor/contextColor semantic mapping', () => {
  setTheme('claude')
  const t = getTheme(3)
  // bash/grep/glob → primary (claude orange)
  assert.equal(t.toolColor('bash'), t.primary)
  assert.equal(t.toolColor('grep'), t.primary)
  assert.equal(t.toolColor('glob'), t.primary)
  // edit/write → secondary (violet)
  assert.equal(t.toolColor('edit_file'), t.secondary)
  assert.equal(t.toolColor('write_file'), t.secondary)
  // run_tests → success (green)
  assert.equal(t.toolColor('run_tests'), t.success)
  // delegate → warning (amber)
  assert.equal(t.toolColor('delegate_task'), t.warning)
  assert.equal(t.toolColor('delegate_batch'), t.warning)
  // unknown → dim
  assert.equal(t.toolColor('unknown_tool_xyz'), t.dim)
})

test('claude theme contextColor threshold ladder matches base ColorSet contract (dim<0.75<warning<0.88<error)', () => {
  setTheme('claude')
  const t = getTheme(3)
  assert.equal(t.contextColor(0.0), t.dim)
  assert.equal(t.contextColor(0.74), t.dim)
  assert.equal(t.contextColor(0.75), t.warning)
  assert.equal(t.contextColor(0.87), t.warning)
  assert.equal(t.contextColor(0.88), t.error)
  assert.equal(t.contextColor(1.0), t.error)
})
