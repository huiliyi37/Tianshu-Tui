import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, setTheme, getActiveThemeName } from '../theme.js'

afterEach(() => { setTheme('antigravity') })

describe('getTheme', () => {
  it('defaults to antigravity theme (对标桌面端 Antigravity 2.0 — cool azure accent)', () => {
    assert.equal(getActiveThemeName(), 'antigravity')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#5aa9ff') // cool azure — 唯一 accent
    assert.equal(theme.error, '#f76b6b')   // coral red
    assert.notEqual(theme.primary, '#d77757') // 不是 Claude 品牌橙
    assert.notEqual(theme.primary, '#c9b8ff') // 不是紫微紫
    assert.notEqual(theme.secondary, '#af87ff') // secondary 也不是紫
  })

  it('antigravity uses neutral white user mark + soft gray body text', () => {
    const theme = getTheme(3)
    assert.equal(theme.userColor, '#e2e6ec')      // 中性亮白 ▌ mark
    assert.equal(theme.assistantColor, '#c4c9d2') // 柔中性灰正文
    assert.equal(theme.pulseActive, '#5aa9ff')    // azure active pulse
  })

  it('slate still available via explicit switch (cool teal accent)', () => {
    setTheme('slate')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#56b6c2') // 冷静 teal
    assert.equal(theme.userColor, '#e2e6ec') // 中性亮白 ▌ mark
    assert.equal(theme.assistantColor, '#c4c9d2') // 柔中性正文
  })

  it('ziwei still available via explicit switch (cinnabar seal)', () => {
    setTheme('ziwei')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#c9b8ff')       // 紫微 — 帝星紫
    assert.equal(theme.userColor, '#d4453a')      // 朱砂印 — user ▌ mark
    assert.equal(theme.pulseAlert, '#d4453a')     // alert pulse
    assert.equal(theme.assistantColor, '#c9b8ff') // assistantColor
  })

  it('tianshu uses cinnabar seal for user mark + alert pulse', () => {
    setTheme('tianshu')
    const theme = getTheme(3)
    assert.equal(theme.userColor, '#d4453a')   // 朱砂印 — user ▌ mark
    assert.equal(theme.pulseAlert, '#d4453a')  // vivid seal, distinct from desaturated error
    assert.equal(theme.assistantColor, '#c5c8d2') // brightened neutral body
  })

  it('returns 256-color fallback when colorLevel < 3 (antigravity → blue accent)', () => {
    const theme = getTheme(1)
    assert.equal(theme.primary, 'blue')
    assert.equal(theme.error, 'red')
  })

  it('maps tool names to colors (ziwei: multi-color per HTML design)', () => {
    setTheme('ziwei')
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
