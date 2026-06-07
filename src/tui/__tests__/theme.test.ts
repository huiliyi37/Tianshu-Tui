import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, setTheme, getActiveThemeName } from '../theme.js'

afterEach(() => { setTheme('midnight') })

describe('getTheme', () => {
  it('defaults to midnight theme', () => {
    assert.equal(getActiveThemeName(), 'midnight')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#58a6ff')
    assert.equal(theme.error, '#f85149')
  })

  it('returns 256-color fallback when colorLevel < 3', () => {
    const theme = getTheme(1)
    assert.equal(theme.primary, 'blue')
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

  it('switches back to midnight theme', () => {
    setTheme('cyberpunk')
    setTheme('midnight')
    assert.equal(getActiveThemeName(), 'midnight')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#58a6ff')
  })
})
