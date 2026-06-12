import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, setTheme, getActiveThemeName } from '../theme.js'

afterEach(() => { setTheme('tianshu') })

describe('getTheme', () => {
  it('defaults to tianshu theme', () => {
    assert.equal(getActiveThemeName(), 'tianshu')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#d4a574') // 星金 accent
    assert.equal(theme.error, '#d07065')   // 朱砂赤
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
    assert.equal(theme.toolColor('bash'), '#9a9dab')        // shell grey
    assert.equal(theme.toolColor('grep'), '#9a9dab')        // same as bash
    assert.equal(theme.toolColor('glob'), '#9a9dab')        // same as bash
    assert.equal(theme.toolColor('edit_file'), '#a095b8')   // 墨紫灰
    assert.equal(theme.toolColor('write_file'), '#a095b8')  // same as edit
    assert.equal(theme.toolColor('run_tests'), '#a89060')   // 金褐
    assert.equal(theme.toolColor('delegate_task'), '#c4a565') // 星金
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
    assert.equal(theme.primary, '#d4a574')
  })
})
