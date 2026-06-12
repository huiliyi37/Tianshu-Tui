import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, setTheme, getActiveThemeName } from '../theme.js'

afterEach(() => { setTheme('tianshu') })

describe('getTheme', () => {
  it('defaults to tianshu theme', () => {
    assert.equal(getActiveThemeName(), 'tianshu')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#c9b8ff') // 紫微紫 accent
    assert.equal(theme.error, '#c1655c')   // 朱砂赤 (desaturated)
  })

  it('tianshu uses cinnabar seal for user mark + alert pulse', () => {
    const theme = getTheme(3)
    assert.equal(theme.userColor, '#d4453a')   // 朱砂印 — user ▌ mark
    assert.equal(theme.pulseAlert, '#d4453a')  // vivid seal, distinct from desaturated error
    assert.equal(theme.assistantColor, '#c5c8d2') // brightened neutral body
  })

  it('returns 256-color fallback when colorLevel < 3', () => {
    const theme = getTheme(1)
    assert.equal(theme.primary, 'yellow')
    assert.equal(theme.error, 'red')
  })

  it('maps tool names to colors (tianshu: multi-color per HTML design)', () => {
    const theme = getTheme(3)
    // tianshu overrides: toolShell ≠ primary, toolEdit ≠ secondary
    assert.equal(theme.toolColor('bash'), '#8c8f9d')        // shell grey (design --tc-shell)
    assert.equal(theme.toolColor('grep'), '#8c8f9d')        // same as bash
    assert.equal(theme.toolColor('glob'), '#8c8f9d')        // same as bash
    assert.equal(theme.toolColor('edit_file'), '#9a90c2')   // 墨紫灰 (design --tc-edit)
    assert.equal(theme.toolColor('write_file'), '#9a90c2')  // same as edit
    assert.equal(theme.toolColor('run_tests'), '#9c8a63')   // 金褐 (design --tc-test)
    assert.equal(theme.toolColor('delegate_task'), '#b09155') // 星金 (design --tc-delegate)
    assert.equal(theme.toolColor('read_file'), theme.dim)
    assert.equal(theme.toolColor('unknown_tool'), theme.dim)
  })

  it('returns context bar color — dim for normal, warning/error for high', () => {
    const theme = getTheme(3)
    assert.equal(theme.contextColor(0.3), theme.dim)    // normal → dim (NOT primary)
    assert.equal(theme.contextColor(0.7), theme.dim)    // still normal → dim
    assert.equal(theme.contextColor(0.76), theme.warning) // 75%+ → warning
    assert.equal(theme.contextColor(0.89), theme.error)   // 88%+ → error
  })

  it('exposes muted color for secondary readable text', () => {
    const theme = getTheme(3)
    assert.equal(typeof theme.muted, 'string')
    assert.ok(theme.muted.length > 0)
    assert.notEqual(theme.muted, theme.dim)
  })
})

describe('theme switching', () => {
  it('switches to cyberpunk theme', () => {
    setTheme('cyberpunk')
    assert.equal(getActiveThemeName(), 'cyberpunk')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#22d3ee')
    assert.equal(theme.error, '#fb7185')
  })

  it('switches back to tianshu theme', () => {
    setTheme('cyberpunk')
    setTheme('tianshu')
    assert.equal(getActiveThemeName(), 'tianshu')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#c9b8ff')
  })
})
