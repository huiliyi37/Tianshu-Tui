import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, setTheme, getActiveThemeName } from '../theme.js'

afterEach(() => { setTheme('pastel') })

describe('getTheme', () => {
  it('defaults to pastel theme', () => {
    assert.equal(getActiveThemeName(), 'pastel')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#a8e6cf')
    assert.equal(theme.error, '#ff9aa2')
  })

  it('returns 256-color fallback when colorLevel < 3', () => {
    const theme = getTheme(1)
    assert.equal(theme.primary, 'cyan')
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
})

describe('theme switching', () => {
  it('switches to cyberpunk theme', () => {
    setTheme('cyberpunk')
    assert.equal(getActiveThemeName(), 'cyberpunk')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#00ffcc')
    assert.equal(theme.error, '#ff3333')
  })

  it('switches back to pastel theme', () => {
    setTheme('cyberpunk')
    setTheme('pastel')
    assert.equal(getActiveThemeName(), 'pastel')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#a8e6cf')
  })
})
