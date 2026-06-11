import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, setTheme, getActiveThemeName } from '../theme.js'

afterEach(() => { setTheme('tianshu') })

describe('getTheme', () => {
  it('defaults to tianshu theme', () => {
    assert.equal(getActiveThemeName(), 'tianshu')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#c9b8ff') // 紫微紫
    assert.equal(theme.error, '#c1655c')   // 朱砂赤
  })

  it('tianshu uses cinnabar seal for user mark + alert pulse', () => {
    const theme = getTheme(3)
    assert.equal(theme.userColor, '#d4453a')   // 朱砂印 — user ▌ mark
    assert.equal(theme.pulseAlert, '#d4453a')  // vivid seal, distinct from desaturated error
    assert.equal(theme.assistantColor, '#a7aab6') // neutral body; emphasis via primary
  })

  it('returns 256-color fallback when colorLevel < 3', () => {
    const theme = getTheme(1)
    assert.equal(theme.primary, 'magenta')
    assert.equal(theme.error, 'red')
  })

  it('maps tool names to border colors', () => {
    const theme = getTheme(3)
    assert.equal(theme.toolColor('bash'), theme.primary)
    assert.equal(theme.toolColor('edit_file'), theme.secondary)
    assert.equal(theme.toolColor('run_tests'), theme.success)
    assert.equal(theme.toolColor('read_file'), theme.dim)
    assert.equal(theme.toolColor('unknown_tool'), theme.dim)
  })

  it('returns context bar color by percentage', () => {
    const theme = getTheme(3)
    assert.equal(theme.contextColor(0.3), theme.primary)
    assert.equal(theme.contextColor(0.7), theme.warning)
    assert.equal(theme.contextColor(0.85), theme.error)
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
