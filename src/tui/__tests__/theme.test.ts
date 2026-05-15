import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme } from '../theme.js'

describe('getTheme', () => {
  it('returns truecolor theme when colorLevel >= 3', () => {
    const theme = getTheme(3)
    assert.equal(theme.primary, '#00ffcc')
    assert.equal(theme.error, '#ff3333')
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
