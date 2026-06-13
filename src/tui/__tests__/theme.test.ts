import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, setTheme, getActiveThemeName } from '../theme.js'

afterEach(() => { setTheme('ziwei') })

describe('getTheme', () => {
  it('defaults to ziwei theme', () => {
    assert.equal(getActiveThemeName(), 'ziwei')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#c9b8ff') // 紫微 — 帝星紫
    assert.equal(theme.error, '#ff8a9b')   // 荧惑赤
  })

  it('ziwei uses cinnabar seal for user mark + alert pulse', () => {
    const theme = getTheme(3)
    assert.equal(theme.userColor, '#d4453a')   // 朱砂印 — user ▌ mark
    assert.equal(theme.pulseAlert, '#d4453a')  // alert pulse
    assert.equal(theme.assistantColor, '#c9b8ff') // assistantColor
  })

  it('tianshu uses cinnabar seal for user mark + alert pulse', () => {
    setTheme('tianshu')
    const theme = getTheme(3)
    assert.equal(theme.userColor, '#d4453a')   // 朱砂印 — user ▌ mark
    assert.equal(theme.pulseAlert, '#d4453a')  // vivid seal, distinct from desaturated error
    assert.equal(theme.assistantColor, '#c5c8d2') // brightened neutral body
  })

  it('returns 256-color fallback when colorLevel < 3', () => {
    const theme = getTheme(1)
    assert.equal(theme.primary, 'magenta')
    assert.equal(theme.error, 'red')
  })

  it('maps tool names to colors (ziwei: multi-color per HTML design)', () => {
    const theme = getTheme(3)
    assert.equal(theme.toolColor('bash'), '#8ab4ff')        // 天枢蓝白 (shell grey in tianshu)
    assert.equal(theme.toolColor('grep'), '#8ab4ff')        // same as bash
    assert.equal(theme.toolColor('glob'), '#8ab4ff')        // same as bash
    assert.equal(theme.toolColor('edit_file'), '#c9b8ff')   // 紫微紫 (design --tc-edit)
    assert.equal(theme.toolColor('write_file'), '#c9b8ff')  // same as edit
    assert.equal(theme.toolColor('run_tests'), '#7ee7c7')   // 归航青 (design --tc-test)
    assert.equal(theme.toolColor('delegate_task'), '#ffd479') // 星金 (design --tc-delegate)
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

  it('switches back to ziwei theme', () => {
    setTheme('cyberpunk')
    setTheme('ziwei')
    assert.equal(getActiveThemeName(), 'ziwei')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#c9b8ff')
  })
})
