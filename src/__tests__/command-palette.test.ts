import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterCommands, getPaletteCommands, type PaletteCommand } from '../tui/command-palette.js'

const COMMANDS: PaletteCommand[] = [
  { name: 'compact', description: 'Compact context' },
  { name: 'model', description: 'Switch model' },
  { name: 'cockpit', description: 'Open cockpit panel' },
  { name: 'clear', description: 'Clear conversation' },
  { name: 'context', description: 'Show context usage' },
]

describe('filterCommands', () => {
  it('returns all for empty query', () => {
    assert.equal(filterCommands(COMMANDS, '').length, 5)
  })

  it('filters by prefix', () => {
    const result = filterCommands(COMMANDS, 'co')
    assert.deepEqual(result.map(r => r.name), ['cockpit', 'compact', 'context', 'clear'])
  })

  it('fuzzy matches by subsequence', () => {
    const result = filterCommands(COMMANDS, 'cpt')
    assert.ok(result.some(r => r.name === 'compact'))
  })

  it('matches description', () => {
    const result = filterCommands(COMMANDS, 'switch')
    assert.equal(result[0]!.name, 'model')
  })

  it('includes discoverable surface entries with palette hotkeys', () => {
    const surfaces = getPaletteCommands().filter(c => c.category === 'surface')
    assert.deepEqual(
      surfaces.map(c => [c.name, c.hotkey]),
      [
        ['__surface:cockpit', 'c'],
        ['__surface:pager', 'p'],
        ['__surface:starmap', 's'],
        ['__surface:chronicle', 'h'],
      ]
    )
  })

  it('includes plan close and team command entries', () => {
    const commands = getPaletteCommands().map(c => c.name)

    assert.ok(commands.includes('/plan-close'))
    assert.ok(commands.includes('/team'))
    assert.ok(commands.includes('/team max'))
  })
})
