import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getPaletteCommands } from '../command-palette.js'

describe('getPaletteCommands', () => {
  it('exposes the pager surface with p hotkey', () => {
    const pager = getPaletteCommands().find(command => command.name === '__surface:pager')

    assert.ok(pager)
    assert.equal(pager.category, 'surface')
    assert.equal(pager.hotkey, 'p')
  })
})
