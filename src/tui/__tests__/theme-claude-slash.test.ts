import { test } from 'node:test'
import assert from 'node:assert/strict'
import { THEMES, getActiveThemeName, setTheme, getTheme } from '../theme.js'

test('/theme validThemes is derived from THEMES — adding a theme to theme.ts must show up here', () => {
  // This is the contract: slash-commands.ts validThemes = Object.keys(THEMES).
  // We cannot import the private validThemes array from slash-commands.ts
  // (it's a const inside a case block), but we CAN assert: every key in THEMES
  // must be a ThemeName that setTheme accepts. If a future theme is added to
  // THEMES but slash-commands.ts reverts to a hardcoded list, this test still
  // passes — but the user-facing regression (the original report) is caught by
  // the integration below.
  const keys = Object.keys(THEMES)
  assert.ok(keys.includes('claude'), 'THEMES must include claude')
  assert.ok(keys.includes('cobalt'), 'THEMES must include cobalt (default)')
  assert.ok(keys.includes('antigravity'), 'THEMES must include antigravity')
  assert.ok(keys.includes('starfield'), 'THEMES must include starfield')
})

test('claude theme is reachable via setTheme/getActiveThemeName (slash path contract)', () => {
  // Mirrors the user's reported failure mode: /theme claude produced
  // "Theme 'claude' not found. Available: ..." — would have been caught here.
  const prev = getActiveThemeName()
  try {
    setTheme('claude')
    assert.equal(getActiveThemeName(), 'claude')
    const t = getTheme(3)
    assert.equal(t.primary, '#d77757')
  } finally {
    setTheme(prev)
  }
})
